#!/usr/bin/env node
import { runServerCli } from "@kk-mcp-kit/core";
import { createServer } from "./server.js";

void runServerCli("project-memory", createServer);
