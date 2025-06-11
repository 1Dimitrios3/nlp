# Setup for MCP Client (Python)

## **Clone the repo** 

   ```bash
    git clone https://github.com/mcp.git
    cd mcp-client
    python3 -m venv .venv
    
    then activate it:

    - On macOS/Linux:
    source .venv/bin/activate

    - On Windows (PowerShell):
    .\.venv\Scripts\Activate.ps1
```

## **Install dependencies**

    ```bash
    # with poetry:
    pip install poetry
    poetry install
```

## Docker

### Build & Run the MCP Server

        ```bash
        # Build the client image
        docker build -t mcp-client .

        # Run the interactive Python client against the server’s SSE endpoint
        docker run --rm -it \
        -e OPENAI_API_KEY="xxxx" \
        -e MODEL_NAME="xxxx" \   # eg. gpt-4o-mini
        -e MCP_SERVER_NAME="xxxxx" \   # eg. mcp-server
        -e MCP_SERVER_URL="http://host.docker.internal:3000/myServerName" \
        -e DB_HOST="host.docker.internal" \
        -e DB_PORT="5432" \
        -e DB_NAME="xxxx" \
        -e DB_USER="xxxx" \
        -e DB_PASSWORD="" \
        mcp-client"" 
        ```

###  System Prompts

Your client relies on a **system prompt** to bootstrap its understanding of the database schema, table relationships, and any special business logic. These prompts live in the `prompts/` folder next to your Python client:


Each file contains:

- A clear description of the domain (e.g. “Netflix usage statistics”)  
- Detailed information of each table and column in your `nlp` database  
- Example queries or guiding constraints to help the LLM generate valid SQL  

### Why it matters

1. **Schema Awareness**  
   The LLM has no intrinsic knowledge of your DB structure. By loading one of these system prompts at startup, you ensure it “knows” exactly which tables exist, what columns they hold, and how they relate.

2. **Preventing Errors**  
   Well-formed system prompts drastically reduce invalid SQL tool calls. If you diverge from the existing prompt templates (or forget to update column names), the model may generate queries against non-existent tables/columns.

### How to choose or add a prompt

**Choose**: In your interactive session, set the initial system message to the contents of one of the existing files:

        ```bash
        from prompts.prompts import nlp_netflix_prompt
        messages = [
            {"role": "system", "content": nlp_netflix_prompt }
        ]
        ```

## Add: To support a new domain:
    - Copy one of the existing .md files in prompts/.
    - Rename it (e.g. nlp_sales_prompt.md).
    - Edit its contents—update table names, column descriptions, sample questions.
    - Import and reference your new prompt in client.py.

## Transports:
    By default the Python client uses SSE (MCP_SERVER_URL=http://host.docker.internal:3000/mcpServer), or switch to STDIO in client.py for a single‐process setup.