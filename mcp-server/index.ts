#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import express, { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { PostgresAdapter } from './db/PostgresAdapter.js';
import "dotenv/config";

const app = express();

const pool = new PostgresAdapter({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const server = new McpServer({
  name: "nlp-server",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: { listChanged: true },
  },
});

// Execute a read‑only SQL query against a given table
server.tool(
  "query",
  "Run a read-only SQL query",
  {
    sql: z.string().describe("The SQL query to execute"),
  },
  async ({ sql }) => {
    console.log(`[MCP] tool “query” called with SQL: ${sql}`);
    // 1) Sanitize the SQL string
    let cleanedSQL = sql.trim()
      // remove wrapping quotes or backticks (e.g. `" … "` or '` … `')
      .replace(/^["'`]+|["'`]+$/g, "")
      // remove a trailing semicolon if present
      .replace(/;$/, "")
      .trim();

    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const { rows } = await client.query(cleanedSQL);

      // Filter out rows with any null values
      const filtered = rows.filter(row =>
        Object.values(row).every(value => value !== null)
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filtered, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: unknown) {
      console.error(`query tool failed for SQL: ${sql}`, error);
      const message = error instanceof Error ? error.message : String(error);
      // Return an MCP error payload
      return {
        content: [
          {
            type: "text",
            text: `Error executing query: ${message}`,
          },
        ],
        isError: true,
      };
    } finally {
      // Always attempt to roll back and release
      client
        .query("ROLLBACK")
        .catch((e) => console.warn("Could not roll back transaction:", e));
      client.release();
    }
  }
);

server.tool(
  "summarize_table",
  "Generate summary statistics for a table: numeric min/avg/max/count and categorical value counts",
  { table: z.string().describe("The table name to summarize") },
  async ({ table }) => {
    console.log(`[MCP] tool 'summarize_table' called with TABLE: ${table}`);
    const client = await pool.connect();
    try {
      // fetch column names + data types
      const { rows: columns } = await client.query<{
        column_name: string;
        data_type: string;
      }>(
        `
        SELECT column_name, data_type
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = $1
        ORDER BY ordinal_position;
        `,
        [table]
      );
      if (columns.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Table "${table}" not found or has no columns in public schema.`,
            },
          ],
          isError: true,
        };
      }

      // classify columns
      const numericTypes = new Set([
        "smallint",
        "integer",
        "bigint",
        "decimal",
        "numeric",
        "real",
        "double precision",
        "serial",
        "bigserial",
      ]);
      const numericCols = columns
        .filter((c) => numericTypes.has(c.data_type))
        .map((c) => c.column_name);

      const categoricalCols = columns
        .filter((c) => !numericTypes.has(c.data_type))
        .map((c) => c.column_name);

      const summary: {
        numeric?: Record<string, { min: number | null; max: number | null; avg: number | null; count: number }>;
        categorical?: Record<string, Record<string, number>>;
      } = {};

      // numeric summaries
      // Build SELECT clauses like: MIN("col") AS "col_min", AVG("col") AS "col_avg", …
        const statsClauses = numericCols
          .map(
            (col) =>
              `MIN("${col}") AS "${col}_min", MAX("${col}") AS "${col}_max", AVG("${col}") AS "${col}_avg", COUNT("${col}") AS "${col}_count"`
          )
          .join(", ");

        const { rows: statRows } = await client.query(
          `SELECT ${statsClauses}
             FROM public."${table}";`
        );
        // the first row has all min/avg/max/count columns
        const row = statRows[0];
        summary.numeric = numericCols.reduce((acc, col) => {
          acc[col] = {
            min: row[`${col}_min`],
            max: row[`${col}_max`],
            avg: row[`${col}_avg`] !== null ? parseFloat(row[`${col}_avg`]) : null,
            count: parseInt(row[`${col}_count`], 10),
          };
          return acc;
        }, {} as Record<string, any>);
      

      // Parallel categorical counts
      if (categoricalCols.length > 0) {
        const catResults = await Promise.all(
          categoricalCols.map(async (col) => {
            const { rows } = await client.query(
              `
              SELECT "${col}" AS value, COUNT(*) AS count
                FROM public."${table}"
               GROUP BY "${col}"
               ORDER BY count DESC
               LIMIT 10;
              `
            );
            const counts = rows.reduce<Record<string, number>>((acc, r) => {
              acc[String(r.value)] = parseInt(r.count, 10);
              return acc;
            }, {});
            return [col, counts] as const;
          })
        );
        summary.categorical = Object.fromEntries(catResults);
      }

      // sample response
      // {
      //   "numeric": {
      //     "revenue": { "min": 100, "avg": 1500, "max": 10000, "count": 500 },
      //     "units_sold": { "min": 1, "avg": 75, "max": 200, "count": 500 }
      //   },
      //   "categorical": {
      //     "product_category": { "Electronics": 250, "Books": 150, "Clothing": 100 }
      //   }
      // }

      // return the summary as JSON text
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: unknown) {
      console.error(`summarize_table failed for "${table}":`, error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error summarizing table "${table}": ${message}`,
          },
        ],
        isError: true,
      };
    } finally {
      client.release();
    }
  }
);

// List all user tables in the “public” schema
server.tool(
  "list_tables",
  "List all tables in the public schema",
  {},                        // no user input
  async () => {
    console.log(`[MCP] tool 'list_tables' called`);
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`
        SELECT table_name 
          FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_type   = 'BASE TABLE';
      `);
      // return an array of table names
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              rows.map(r => r.table_name),
              null,
              2
            ),
          },
        ],
        isError: false,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      console.error("list_tables failed:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error listing tables: ${message}`,
          },
        ],
        isError: true,
      };
    } finally {
      client.release();
    }
  }
);

// Describe the columns on a given table
server.tool(
  "describe_table",
  "Describe the columns of a table",
  { table: z.string().describe("The table name to inspect") },
  async ({ table }) => {
    console.log(`[MCP] tool 'describe_table' called with TABLE: ${table}`);
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `
        SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = $1
        ORDER BY ordinal_position;
        `,
        [table]
      );
      return {
        content: [
          { type: "text", text: JSON.stringify(rows, null, 2) }
        ],
        isError: false
      };
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : String(error);
      console.error(`describe_table failed for "${table}":`, error);
      return {
        content: [
          {
            type: "text",
            text: `Error describing table "${table}": ${message}`
          }
        ],
        isError: true
      };
    } finally {
      client.release();
    }
  }
)


// ———————— Startup stdio ————————

// async function runServer() {
//   console.log(`✅ MCP-Postgres server starting up...`);
//   const transport = new StdioServerTransport();
//   await server.connect(transport);
//   console.log(`🚀 MCP-Postgres server ready and waiting for requests`);
// }

// ———————— Startup sse ————————

async function runServer() {
  console.log(`✅ MCP-Postgres HTTP server starting up...`);

  const transports = new Map<string, SSEServerTransport>();

  // Client opens an SSE stream here:
  app.get(
    "/nlp",
    (_req: Request, res: Response) => {
      console.log("→ got GET /nlp");
      const transport = new SSEServerTransport("/messages", res);

       // capture its sessionId and store in our map
      const sid = transport.sessionId!;
      transports.set(sid, transport);
      console.log(`→ New SSE session registered: ${sid}`);

      // cleanup when the client disconnects
      transport.onclose = () => {
        transports.delete(sid);
        console.log(`← SSE session closed: ${sid}`);
      };
      
      server.connect(transport);
    }
  );

  // JSON‑RPC calls POSTed here:
  app.post(
    "/messages",
    (req: Request, res: Response, next: NextFunction): any => {
      // look for sessionId in header or query
      const sid =
        (req.headers["mcp-session-id"] as string) ||
        new URL(req.url, `http://${req.headers.host}`)
          .searchParams.get("sessionId");
      
      if (!sid) {
        return res.status(400).send("Missing session ID");
      }

      const transport = transports.get(sid);

      if (!transport) {
        return res.status(400).send("No SSE connection");
      }

      // Debug mode
      // console.log("→ POST /messages");
      // console.log("   req.url    =", req.url);
      // console.log("   headers    =", req.headers);
      // console.log("▶ raw /messages body:", JSON.stringify(req.body));
      try {
        transport.handlePostMessage(req, res);
      } catch (err) {
        next(err);
      }
    }
);

 // Start the HTTP server
 const port = process.env.PORT || 3000;
 app.listen(port, () => {
   console.log(`🚀 MCP HTTP Server listening on http://localhost:${port}`);
 });
}

runServer().catch((e: unknown) => {
  console.error("Fatal error starting server:", e);
  process.exit(1);
});