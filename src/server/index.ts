/**
 * Express application entry point.
 *
 * Mounts CORS, JSON body parsing, the API router, and the top-level error
 * handler, then starts listening on port 3001.
 */

import express from "express";
import cors from "cors";
import { router, apiErrorHandler } from "./routes.js";
import { startOutputSweep } from "./renderer.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", router);

// Must be registered after routes — four-param signature identifies it as
// an Express error handler
app.use(apiErrorHandler);

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

// Begin periodic cleanup of expired render output files.
startOutputSweep();

export default app;
