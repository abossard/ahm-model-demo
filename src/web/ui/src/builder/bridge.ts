import { App } from "@modelcontextprotocol/ext-apps";
import type { AnalysisRow, BuilderTools } from "./types";
import { builderDestination } from "./builderDestinations";

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;

export function toolValue<T>(result: ToolResult): T {
  if (result.isError) {
    throw new Error(
      result.content?.find((c) => c.type === "text")?.text || "The host could not complete this action.",
    );
  }
  if (!result.structuredContent) throw new Error("The host returned an incomplete builder response.");
  return result.structuredContent as T;
}

export function builderTools(app: App): BuilderTools {
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return toolValue<T>(await app.callServerTool({ name, arguments: args }, { timeout: 300_000 }));
  }
  const reviewedRows = (rows: AnalysisRow[]) =>
    rows.map(({ resourceId, purpose, impact }) => ({ resourceId, purpose, impact }));
  return {
    open: (sessionId) => call("builder_open", { sessionId }),
    groups: () => call("builder_inventory", {}),
    resources: (groupId) => call("builder_inventory", { groupId }),
    analyze: (scope, sessionId) => call("builder_analyze", { ...scope, ...(sessionId ? { sessionId } : {}),
      showMeHandles: [builderDestination("analyze")] }),
    revise: (sessionId, analysisSeq, rows, prompt) => call("builder_revise", {
      sessionId, analysisSeq, rows: reviewedRows(rows), prompt, showMeHandles: [builderDestination("analyze")],
    }),
    propose: (sessionId, analysisSeq, rows) => call("builder_propose", {
      sessionId, analysisSeq, rows: reviewedRows(rows), showMeHandles: [builderDestination("propose")],
    }),
    preview: (sessionId, proposalSeq, proposalId) =>
      call("builder_preview", { sessionId, proposalSeq, proposalId }),
    create: (sessionId, proposalSeq, proposalId) =>
      call("builder_create", { sessionId, proposalSeq, proposalId, confirmed: true }),
    grantMonitoring: (sessionId, proposalSeq) =>
      call("builder_grant_monitoring", { sessionId, proposalSeq, confirmed: true }),
    showModel: (sessionId, proposalSeq, tour) => call("builder_open_model", { sessionId, proposalSeq, ...(tour && { tour }) }),
    download: async (name, text) => {
      const result = await app.downloadFile({
        contents: [{ type: "resource", resource: { uri: "file:///" + name, mimeType: "text/markdown", text } }],
      });
      if (result.isError) throw new Error("The host could not download " + name + ".");
    },
  };
}
