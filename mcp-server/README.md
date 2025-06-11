# PostgreSQL Natural Language queries

A Model Context Protocol server that provides read-only access to PostgreSQL databases. This server enables LLMs to inspect database schemas and execute read-only queries.

## Components

### Tools

- **query**
  - Execute read-only SQL queries against the connected database
  - Input: `sql` (string): The SQL query to execute
  - All queries are executed within a READ ONLY transaction

- **list_tables**
  - Retrieve the names of all base tables in the database’s “public” schema
  - Returns a JSON‐formatted list of table names

- **describe_table**
  - Retrieve column metadata (name, data type, and nullability) for a specified table in the public schema
  - Input: table (string) – the name of the table to inspect
  - Returns a JSON‐formatted array of objects, each containing column_name, data_type, and is_nullable

- **summarize_table**
  - Generate summary statistics for a specified table’s columns (min, avg, max, count for numeric fields)
  - Compute top value counts (up to 10) for each non-numeric (categorical) column
  - Accepts a single input: table (string), the name of the table in the public schema
  - Returns a JSON-formatted summary of numeric metrics   and categorical counts, or an error message if the table doesn’t exist or the query fails

### Resources

To add your own data and make it queryable:

- Place a UTF-8 encoded CSV file in `mcp-server/data/`
- Run `lib/seed.ts` to import that CSV as a new table in the database
- Once the table is seeded, you can query it using natural language via the existing MCP tools

## Configuration

### Docker

### Build & Run the MCP Server

    ```bash
    # Build the server image
    docker build -t mcp-server .

    # Run the server, exposing port 3000 and wiring up Postgres env vars
    docker run -d \
      -p 3000:3000 \
      -e DB_HOST=host.docker.internal \
      -e DB_PORT=5432 \
      -e DB_NAME=your_db_name \
      -e DB_USER=your_db_user \
      -e DB_PASSWORD=your_db_password \
      --name mcp-server-container \
      your_mcp_server_name

    # Tail the server logs
    docker logs -f mcp-server-container
    ```

### Run with Docker Compose
    ```bash
    # create a docker-compose.yml file
    # run both the server and client at once 
    docker-compose build
    docker compose run --rm --service-ports mcp-client
    # stop and remove the containers
    docker-compose down
    ```

## Switching Databases or Environment
To use a different database or LLM model, just edit the relevant environment: variables in your docker-compose.yml for both mcp-server and mcp-client, then repeat the steps above.

## 🎵 Example Dataset
You can test this stack using the [Pitchfork music reviews dataset](https://www.kaggle.com/datasets/nolanbconaway/pitchfork-data) (available as .sqlite).
To use it with Postgres, first transform the SQLite database to PostgreSQL format using eg. pgloader on cli.
Once loaded, update your docker-compose.yml environment variables to point to your new database.
You can find and use the example system prompt for Pitchfork in the client code as `nlp_pitchfork_prompt`.
