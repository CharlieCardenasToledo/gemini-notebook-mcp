/**
 * MCP Tool Definitions
 *
 * Aggregates tool definitions from sub-modules.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { askQuestionTool } from "./definitions/ask-question.js";
import { notebookManagementTools } from "./definitions/notebook-management.js";
import { sessionManagementTools } from "./definitions/session-management.js";
import { systemTools } from "./definitions/system.js";
import { sourceTools } from "./definitions/sources.js";

/**
 * Build static tool definitions. User-controlled notebook metadata is returned
 * as data by notebook tools and is never embedded in trusted descriptions.
 */
export function buildToolDefinitions(): Tool[] {
  return [
    askQuestionTool,
    ...notebookManagementTools,
    ...sessionManagementTools,
    ...systemTools,
    ...sourceTools,
  ];
}
