import os
import asyncio
from typing import AsyncIterator

from client import MCPClient, mcp_session
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware 
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dotenv import load_dotenv
from prompts.prompts import nlp_unicorns_prompt

from config import (
    LLMClientConfig,
    LLMRequestConfig,
    MCPClientConfig,
    SseServerConfig,
)

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],    
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    query: str
    model_name: str = None


@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    # Validate environment variables
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if not openai_api_key:
        raise HTTPException(status_code=500, detail="Missing OPENAI_API_KEY")

    mcp_server_name = os.getenv("MCP_SERVER_NAME")
    if not mcp_server_name:
        raise HTTPException(status_code=500, detail="Missing MCP_SERVER_NAME")

    mcp_url = os.getenv("MCP_SERVER_URL")
    if not mcp_url:
        raise HTTPException(status_code=500, detail="Missing MCP_SERVER_URL")

    # Build configs with stream=True so that process_messages uses its streaming branch
    llm_cfg = LLMClientConfig(api_key=openai_api_key)
    llm_req_cfg = LLMRequestConfig(model=request.model_name or os.environ['MODEL_NAME'], stream=True)

    mcp_cfg = MCPClientConfig(
        mcpServers={mcp_server_name: SseServerConfig(url=mcp_url)}
    )

    # Instantiate and configure MCPClient
    client = MCPClient(llm_cfg, llm_req_cfg)

    # Create a queue to relay chunks from MCPClient._stream_response → HTTP
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def custom_stream_response(streaming_resp):
        """
        Replacement for MCPClient._stream_response.
        Instead of printing, put each delta.content into `queue`.
        Finally, put None to signal completion.
        """
        async for chunk in streaming_resp:
            delta = chunk.choices[0].delta
            if delta.content:
                await queue.put(delta.content)
        # Signal that streaming is done
        await queue.put(None)

    async def event_generator() -> AsyncIterator[str]:
        """
        This async generator:
        1) Opens the MCP session,
        2) Runs process_messages (which pushes to `queue`),
        3) Yields each piece as an SSE `data:` chunk,
        4) Closes when `None` is received.
        The lifetime of the MCP session remains open until the generator completes.
        """
        # 1) Open SSE‐based MCP session
        async with mcp_session(mcp_cfg.mcpServers[mcp_server_name]) as session:
            await client.set_session(session)
            # Monkey‐patch _stream_response on the client
            client._stream_response = custom_stream_response  # type: ignore

            # 2) Prepare the “system + user” messages
            messages = [
                {"role": "system", "content": nlp_unicorns_prompt},
                {"role": "user", "content": request.query},
            ]

            # 3) Kick off process_messages in the background;
            #    it will internally call custom_stream_response → queue
            task = asyncio.create_task(client.process_messages(messages))

            # 4) Read from queue and yield SSE frames
            while True:
                chunk = await queue.get()
                if chunk is None:
                    yield "event: close\ndata: [DONE]\n\n"
                    break
                yield f"data: {chunk}\n\n"

            # 5) Ensure the background task is done before exiting the session
            await task

    # Return a StreamingResponse that binds the generator
    return StreamingResponse(event_generator(), media_type="text/event-stream")