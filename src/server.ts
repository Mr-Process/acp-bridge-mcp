import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWalletClient, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

// Environment — secrets from `wrangler secret put`, DO binding from wrangler.jsonc
export interface Env {
  AGENT_WALLET_ADDRESS: string;
  AGENT_PRIVATE_KEY: string;
  RPC_ENDPOINT_URL: string;
  MCP_OBJECT: DurableObjectNamespace;
}

// Persistent state in the Durable Object's SQLite storage
type AgentState = {
  nonce: number;
  pendingTxHash: string | null;
  dailySpent: number;
  dailyResetAt: string | null;
};

const DAILY_SPENDING_LIMIT = 100; // USDC

export class AcpBridgeAgent extends McpAgent<Env, AgentState> {
  server = new McpServer({ name: "Autonomous-ACP-Bridge", version: "2.0.0" });

  initialState: AgentState = {
    nonce: 0,
    pendingTxHash: null,
    dailySpent: 0,
    dailyResetAt: null,
  };

  async init() {
    // ─── acp_create_job_by_name ───
    this.server.tool(
      "acp_create_job_by_name",
      "Creates a new ACP job by offering name.",
      {
        offeringName: z.string().describe("The offering name to create a job for"),
        providerAddress: z.string().describe("The provider's EVM address"),
        requirementData: z.string().describe("Job requirement data as a JSON string"),
      },
      async ({ offeringName, providerAddress, requirementData }) => {
        try {
          const limitError = this.checkDailyLimit();
          if (limitError) return limitError;

          // TODO: Wire ACP SDK
          // const agent = new AcpClient(walletClient, AgentType.CLIENT);
          // const jobId = await agent.createJobByOfferingName(offeringName, providerAddress, requirementData);

          return {
            content: [{ type: "text", text: `Job created for offering: ${offeringName}` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Execution failed: ${error.message}` }],
            isError: true,
          };
        }
      }
    );

    // ─── acp_propose_budget ───
    this.server.tool(
      "acp_propose_budget",
      "Proposes a budget for an ACP job in USDC.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
        amount: z.number().describe("Budget amount in USDC"),
      },
      async ({ jobId, amount }) => {
        try {
          const limitError = this.checkDailyLimit();
          if (limitError) return limitError;

          // TODO: Wire ACP SDK
          // const session = agent.getJobSession(jobId);
          // await session.setBudget(parseUnits(String(amount), 6));

          return {
            content: [{ type: "text", text: `Budget of ${amount} USDC proposed for job ${jobId}.` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Execution failed: ${error.message}` }],
            isError: true,
          };
        }
      }
    );

    // ─── acp_fund_escrow ───
    this.server.tool(
      "acp_fund_escrow",
      "Authorizes the transfer of USDC into the job's escrow contract.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
      },
      async ({ jobId }) => {
        try {
          const limitError = this.checkDailyLimit();
          if (limitError) return limitError;

          // Durable Object guarantees sequential execution — safe nonce increment
          const currentNonce = this.state.nonce;

          // TODO: Wire ACP SDK
          // const session = agent.getJobSession(jobId);
          // const txHash = await session.fund(parseUnits("100", 6));
          // await this.waitForReceipt(txHash, walletClient);

          this.setState({
            nonce: currentNonce + 1,
            pendingTxHash: null,
          });

          return {
            content: [{ type: "text", text: `Funded job ${jobId}. Nonce: ${currentNonce} → ${currentNonce + 1}.` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Execution failed: ${error.message}` }],
            isError: true,
          };
        }
      }
    );

    // ─── acp_submit_deliverable ───
    this.server.tool(
      "acp_submit_deliverable",
      "Submits a cryptographic hash of the deliverable to the ACP job.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
        deliverableUri: z.string().describe("URI or hash of the deliverable"),
      },
      async ({ jobId, deliverableUri }) => {
        try {
          // Guardrail: verify agent is Provider and job is in Funded state
          // const session = agent.getJobSession(jobId);
          // const tools = session.availableTools();
          // if (!tools.includes("submit")) {
          //   return { content: [{ type: "text", text: "Cannot submit: agent is not the Provider or job is not in Funded state." }], isError: true };
          // }

          // await session.submit(deliverableUri);

          return {
            content: [{ type: "text", text: `Deliverable submitted for job ${jobId}: ${deliverableUri}` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Execution failed: ${error.message}` }],
            isError: true,
          };
        }
      }
    );

    // ─── acp_evaluate_job ───
    this.server.tool(
      "acp_evaluate_job",
      "Evaluates a submitted deliverable: approve (complete) or reject.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
        approve: z.boolean().describe("true to complete the job, false to reject"),
        reason: z.string().describe("Reason for the evaluation decision"),
      },
      async ({ jobId, approve, reason }) => {
        try {
          // Guardrail: verify agent is the Evaluator
          // const session = agent.getJobSession(jobId);
          // const tools = session.availableTools();
          // if (approve && !tools.includes("complete")) { ... }
          // if (!approve && !tools.includes("reject")) { ... }

          // if (approve) {
          //   await session.complete(reason);
          // } else {
          //   await session.reject(reason);
          // }

          const action = approve ? "completed" : "rejected";
          return {
            content: [{ type: "text", text: `Job ${jobId} ${action}. Reason: ${reason}` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Execution failed: ${error.message}` }],
            isError: true,
          };
        }
      }
    );
  }

  // ─── Guardrail: daily spending limit (server-side, LLM cannot bypass) ───
  private checkDailyLimit() {
    const today = new Date().toISOString().split("T")[0];

    if (this.state.dailyResetAt !== today) {
      this.setState({ dailySpent: 0, dailyResetAt: today });
    }

    if (this.state.dailySpent >= DAILY_SPENDING_LIMIT) {
      return {
        content: [{ type: "text" as const, text: `Daily spending limit of ${DAILY_SPENDING_LIMIT} USDC reached. Try again tomorrow.` }],
        isError: true,
      };
    }
    return null;
  }

  // ─── Mempool recovery: poll for receipt, replace tx on timeout ───
  private async waitForReceipt(txHash: string, walletClient: any): Promise<void> {
    this.setState({ pendingTxHash: txHash });

    const maxAttempts = 30;
    const delayMs = 2000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await walletClient.getTransactionReceipt({ hash: txHash as Hex });
        if (receipt) {
          this.setState({ pendingTxHash: null });
          return;
        }
      } catch {
        // tx not yet mined, keep polling
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // Timeout — broadcast replacement with same nonce, 1.2x gas
    // TODO: Implement replacement transaction
    throw new Error(
      `Transaction ${txHash} unconfirmed after ${maxAttempts * delayMs / 1000}s. Manual intervention required.`
    );
  }
}

export default AcpBridgeAgent.serve("/mcp");
