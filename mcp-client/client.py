import asyncio
import json
import os
from typing import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict

from dotenv import load_dotenv
from openai import AsyncOpenAI
from openai.types.chat.chat_completion_message_tool_call_param import Function
from openai.types.shared_params.function_definition import FunctionDefinition
from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCallParam,
    ChatCompletionToolMessageParam,
    ChatCompletionToolParam,
)

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.sse import sse_client
from prompts.prompts import nlp_unicorns_prompt, nlp_netflix_prompt, nlp_pitchfork_prompt

from config import LLMClientConfig, LLMRequestConfig, MCPClientConfig, MCPServerConfig, SseServerConfig, StdioServerConfig

load_dotenv()

@asynccontextmanager
async def mcp_session(cfg: MCPServerConfig) -> AsyncIterator[ClientSession]:
    """Bring up a single MCP stdio/sse transport + session, yield the session."""

    # sse
    if isinstance(cfg, SseServerConfig):
        async with sse_client(url=cfg.url) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                await session.initialize()
                yield session
    # stdio
    elif isinstance(cfg, StdioServerConfig):
         params = StdioServerParameters(
             command=cfg.command,
             args=cfg.args,
             env=getattr(cfg, "env", None),
         )
         async with stdio_client(params) as (read, write):
             async with ClientSession(read, write) as session:
                 await session.initialize()
                 yield session
    else:
        raise ValueError("Unsupported server config")


class MCPClient:
    def __init__(self, llm_cfg: LLMClientConfig, llm_req_cfg: LLMRequestConfig):
        self.llm_client = AsyncOpenAI(
            api_key=llm_cfg.api_key,
            base_url=llm_cfg.base_url,
        )
        self.llm_req_cfg = llm_req_cfg
        self.session = None
        self._tools = None

    async def set_session(self, session: ClientSession):
        self.session = session
        self._tools = await self._load_tools()

    async def _load_tools(self) -> list[ChatCompletionToolParam]:
        raw = await self.session.list_tools()
        return [
            ChatCompletionToolParam(
                type="function",
                function=FunctionDefinition(
                    name=t.name,
                    description=t.description or "",
                    parameters=t.inputSchema,
                )
            )
            for t in raw.tools
        ]
    
    async def _call_llm(self, messages, tools, **params):
        return await self.llm_client.chat.completions.create(
            messages=messages, tools=tools, tool_choice="auto", **params
        )
    
    async def _handle_tool_calls(self, resp, messages):
        msg = resp.choices[0].message
        messages.append(ChatCompletionAssistantMessageParam(
            role="assistant",
            tool_calls=[
                ChatCompletionMessageToolCallParam(
                    id=tc.id,
                    function=Function(
                        name=tc.function.name,
                        arguments=tc.function.arguments,
                    ),
                    type=tc.type,
                )
                for tc in msg.tool_calls
            ]
        ))
        for tc in msg.tool_calls:
            messages.append(await self.process_tool_call(tc))

    async def _handle_stop(self, resp, messages, tools, params, stream_on):
        msg = resp.choices[0].message
        if stream_on:
            params.pop("stream", None)
            stream = await self.llm_client.chat.completions.create(
                messages=messages, tools=tools, tool_choice="auto", stream=True, **params
            )
            await self._stream_response(stream)
            return messages
        else:
            messages.append(ChatCompletionAssistantMessageParam(
                role="assistant", content=msg.content
            ))
            return messages
    
    async def _stream_response(self, streaming_resp):
        async for chunk in streaming_resp:
            delta = chunk.choices[0].delta
            if delta.content:
                ## uncomment only if you want to forward chunks via a chat endpoint
                # yield delta.content
                ## prints to the terminal
                print(delta.content, end="", flush=True)

    async def process_tool_call(self, tool_call) -> ChatCompletionToolMessageParam:
        if tool_call.type != "function":
            raise ValueError(f"Unknown tool call type: {tool_call.type}")

        name = tool_call.function.name
        args = json.loads(tool_call.function.arguments)

        # 🔍 print the raw SQL we’re about to run
        if "query" in args:
            print(f"\n📝 [LLM → SQL] {args['query']}\n")
            
        result = await self.session.call_tool(name, args)

        if result.isError:
            raise RuntimeError(f"Tool {name} error")

        # assume text-only for simplicity
        contents = [
            r.text for r in result.content if r.type == "text"
        ]
        return ChatCompletionToolMessageParam(
            role="tool",
            content=json.dumps({**args, name: contents}),
            tool_call_id=tool_call.id,
        )

    async def process_messages(
        self,
        messages: list[ChatCompletionMessageParam],
    ) -> list[ChatCompletionMessageParam]:
        if not self.session:
            raise RuntimeError("No MCP session set")
        
        # Extract our config
        llm_params = {**asdict(self.llm_req_cfg)}
        stream_on = llm_params.pop("stream", False)
        tools = self._tools

        while True:
            resp = await self._call_llm(messages, tools, **llm_params)
            decision   = resp.choices[0].finish_reason

            match decision:
                case "tool_calls":
                    await self._handle_tool_calls(resp, messages)
                case "stop":
                    return await self._handle_stop(resp, messages, tools, llm_params, stream_on)
                case other:
                    raise ValueError(f"Unexpected finish_reason: {other}")

async def main():
    # load configs...
    mcp_cfg = MCPClientConfig(
        mcpServers={
            # uncomment for STDIO server
            # os.environ["MCP_SERVER_NAME"]: StdioServerConfig(
            #     command="node",
            #     args=[
            #         "../mcp-server/server/dist/index.js"
            #     ],
            #     env={
            #          "DB_HOST": os.environ["DB_HOST"],
            #          "DB_PORT": os.environ["DB_PORT"],
            #          "DB_NAME": os.environ["DB_NAME"],
            #          "DB_USER": os.environ["DB_USER"],
            #          "DB_PASSWORD": os.environ["DB_PASSWORD"],
            #     },
            # ),
            # uncomment for SSE server
            os.environ["MCP_SERVER_NAME"]: SseServerConfig(
                url=os.environ["MCP_SERVER_URL"],
            ),
        }
    )
    llm_cfg  = LLMClientConfig(
        api_key=os.environ["OPENAI_API_KEY"]
    )
    llm_req_cfg = LLMRequestConfig(model=os.environ["MODEL_NAME"], stream=True)

    client = MCPClient(llm_cfg, llm_req_cfg)

    # ——— NLP ———

    async with mcp_session(mcp_cfg.mcpServers[os.environ["MCP_SERVER_NAME"]]) as nlp_sess:
        await client.set_session(nlp_sess)
        print("\n=== Server Responding... ===")
        # Initialize “messages” with a single system prompt
        messages: list[ChatCompletionMessageParam] = [
            {"role": "system", "content": nlp_unicorns_prompt}
        ]

        print("\n=== Entering interactive mode. Type ‘exit’ or ‘quit’ to end. ===\n")

        while True:
            user_input = await asyncio.to_thread(input, "You: ")
            if user_input.strip().lower() in ("exit", "quit"):
                print("Thanks for chatting with me. Feel free to reach out any time you have a question.")
                break

            # Append the user message to the conversation history
            messages.append({"role": "user", "content": user_input})

            # Call the LLM + any tools; print streamed output as it arrives
            await client.process_messages(messages)

            print()  # just to make sure we start the next prompt on a fresh line


if __name__ == "__main__":
    asyncio.run(main())