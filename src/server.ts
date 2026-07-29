import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseSepolia } from "viem/chains";
import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
  AssetToken,
  type AcpTool,
} from "@virtuals-protocol/acp-node-v2";

// Environment — secrets from `wrangler secret put`, DO binding from wrangler.jsonc
export interface Env {
  AGENT_WALLET_ADDRESS: string;
  AGENT_PRIVATE_KEY: string;
  RPC_ENDPOINT_URL: string;
  WALLET_ID: string;
  SIGNER_PRIVATE_KEY: string;
  BUILDER_CODE: string;
  MCP_OBJECT: DurableObjectNamespace;
}

// Persistent state in the Durable Object's SQLite storage
type AgentState = {
  nonce: number;
  pendingTxHash: string | null;
  dailySpent: number;
  dailyResetAt: string | null;
  agentStarted: boolean;
};

const DAILY_SPENDING_LIMIT = 100; // USDC
const BASE_SEPOLIA_CHAIN_ID = 84532;

export class AcpBridgeAgent extends McpAgent<Env, AgentState> {
  server = new McpServer({ name: "Autonomous-ACP-Bridge", version: "2.0.0" });

  initialState: AgentState = {
    nonce: 0,
    pendingTxHash: null,
    dailySpent: 0,
    dailyResetAt: null,
    agentStarted: false,
  };

  // Lazily-initialized ACP agent — persists across requests within the DO lifecycle
  private acpAgent: AcpAgent | null = null;

  private async getAcpAgent(): Promise<AcpAgent> {
    if (this.acpAgent) return this.acpAgent;

    const provider = await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: this.env.AGENT_WALLET_ADDRESS as `0x${string}`,
      walletId: this.env.WALLET_ID,
      signerPrivateKey: this.env.SIGNER_PRIVATE_KEY,
      chains: [baseSepolia],
      builderCode: this.env.BUILDER_CODE || undefined,
    });

    this.acpAgent = await AcpAgent.create({
      evmProvider: provider,
    });

    return this.acpAgent;
  }

  async init() {
    // ─── acp_create_job_by_name ───
    this.server.tool(
      "acp_create_job_by_name",
      "Creates a new ACP job by offering name on Base Sepolia. Returns the on-chain job ID.",
      {
        offeringName: z.string().describe("The offering name to create a job for"),
        providerAddress: z.string().describe("The provider's EVM address (0x...)"),
        requirementData: z.string().describe("Job requirement data as a JSON string"),
        evaluatorAddress: z
          .string()
          .optional()
          .describe("Evaluator's EVM address. Omit for skip-evaluation (auto-complete on submit)."),
      },
      async ({ offeringName, providerAddress, requirementData, evaluatorAddress }) => {
        try {
          const limitError = this.checkDailyLimit();
          if (limitError) return limitError;

          const agent = await this.getAcpAgent();

          let requirementPayload: Record<string, unknown> | string;
          try {
            requirementPayload = JSON.parse(requirementData);
          } catch {
            requirementPayload = requirementData;
          }

          const opts: { evaluatorAddress?: string } = {};
          if (evaluatorAddress) opts.evaluatorAddress = evaluatorAddress;

          const jobId = await agent.createJobByOfferingName(
            BASE_SEPOLIA_CHAIN_ID,
            offeringName,
            providerAddress,
            requirementPayload,
            opts
          );

          this.setState({ nonce: this.state.nonce + 1 });

          return {
            content: [
              {
                type: "text",
                text: `Job created on Base Sepolia.\nJob ID: ${jobId}\nOffering: ${offeringName}\nProvider: ${providerAddress}`,
              },
            ],
          };
        } catch (error) {
          return this.formatError(error);
        }
      }
    );

    // ─── acp_propose_budget ───
    this.server.tool(
      "acp_propose_budget",
      "Proposes a budget for an ACP job in USDC. Must be called by the Client before funding.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
        amount: z.number().describe("Budget amount in USDC"),
      },
      async ({ jobId, amount }) => {
        try {
          const limitError = this.checkDailyLimit();
          if (limitError) return limitError;

          const agent = await this.getAcpAgent();
          const session = agent.getSession(BASE_SEPOLIA_CHAIN_ID, jobId);

          if (!session) {
            return {
              content: [{ type: "text", text: `No active session for job ${jobId}. Create the job first.` }],
              isError: true,
            };
          }

          const tools = session.availableTools();
          if (!tools.some((t: AcpTool) => t.name === "setBudget")) {
            return {
              content: [{ type: "text", text: "Cannot set budget: agent is not the Client or job is past the budget phase." }],
              isError: true,
            };
          }

          const budget = AssetToken.usdc(amount, BASE_SEPOLIA_CHAIN_ID);
          await session.setBudget(budget);

          this.setState({
            dailySpent: this.state.dailySpent + amount,
            nonce: this.state.nonce + 1,
          });

          return {
            content: [{ type: "text", text: `Budget of ${amount} USDC proposed for job ${jobId}.` }],
          };
        } catch (error) {
          return this.formatError(error);
        }
      }
    );

    // ─── acp_fund_escrow ───
    this.server.tool(
      "acp_fund_escrow",
      "Authorizes the transfer of USDC into the job's escrow contract. Must be called by the Client after budget is set.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
      },
      async ({ jobId }) => {
        try {
          const limitError = this.checkDailyLimit();
          if (limitError) return limitError;

          const agent = await this.getAcpAgent();
          const session = agent.getSession(BASE_SEPOLIA_CHAIN_ID, jobId);

          if (!session) {
            return {
              content: [{ type: "text", text: `No active session for job ${jobId}.` }],
              isError: true,
            };
          }

          const tools = session.availableTools();
          if (!tools.some((t: AcpTool) => t.name === "fund")) {
            return {
              content: [{ type: "text", text: "Cannot fund: agent is not the Client or job is not in Budget Set state." }],
              isError: true,
            };
          }

          await session.fund();

          this.setState({ nonce: this.state.nonce + 1 });

          return {
            content: [{ type: "text", text: `Escrow funded for job ${jobId}. USDC locked in escrow contract.` }],
          };
        } catch (error) {
          return this.formatError(error);
        }
      }
    );

    // ─── acp_submit_deliverable ───
    this.server.tool(
      "acp_submit_deliverable",
      "Submits a deliverable (URI or hash) to the ACP job. Must be called by the Provider after escrow is funded.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
        deliverableUri: z.string().describe("URI or hash of the deliverable"),
      },
      async ({ jobId, deliverableUri }) => {
        try {
          const agent = await this.getAcpAgent();
          const session = agent.getSession(BASE_SEPOLIA_CHAIN_ID, jobId);

          if (!session) {
            return {
              content: [{ type: "text", text: `No active session for job ${jobId}.` }],
              isError: true,
            };
          }

          const tools = session.availableTools();
          if (!tools.some((t: AcpTool) => t.name === "submit")) {
            return {
              content: [{ type: "text", text: "Cannot submit: agent is not the Provider or job is not in Funded state." }],
              isError: true,
            };
          }

          await session.submit(deliverableUri);

          this.setState({ nonce: this.state.nonce + 1 });

          return {
            content: [{ type: "text", text: `Deliverable submitted for job ${jobId}: ${deliverableUri}` }],
          };
        } catch (error) {
          return this.formatError(error);
        }
      }
    );

    // ─── acp_evaluate_job ───
    this.server.tool(
      "acp_evaluate_job",
      "Evaluates a submitted deliverable: approve (complete) or reject. Must be called by the Evaluator.",
      {
        jobId: z.string().describe("The unique on-chain ID of the job"),
        approve: z.boolean().describe("true to complete the job (release escrow), false to reject (refund)"),
        reason: z.string().describe("Reason for the evaluation decision"),
      },
      async ({ jobId, approve, reason }) => {
        try {
          const agent = await this.getAcpAgent();
          const session = agent.getSession(BASE_SEPOLIA_CHAIN_ID, jobId);

          if (!session) {
            return {
              content: [{ type: "text", text: `No active session for job ${jobId}.` }],
              isError: true,
            };
          }

          const tools = session.availableTools();
          const requiredTool = approve ? "complete" : "reject";

          if (!tools.some((t: AcpTool) => t.name === requiredTool)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Cannot ${requiredTool}: agent is not the Evaluator or job is not in Submitted state.`,
                },
              ],
              isError: true,
            };
          }

          if (approve) {
            await session.complete(reason);
          } else {
            await session.reject(reason);
          }

          this.setState({ nonce: this.state.nonce + 1 });

          const action = approve ? "completed (escrow released to Provider)" : "rejected (escrow refunded to Client)";
          return {
            content: [{ type: "text", text: `Job ${jobId} ${action}.\nReason: ${reason}` }],
          };
        } catch (error) {
          return this.formatError(error);
        }
      }
    );

    // ─── acp_browse_agents ───
    this.server.tool(
      "acp_browse_agents",
      "Browse registered ACP agents by keyword. Returns agent details including offerings.",
      {
        keyword: z.string().describe("Search keyword (e.g. 'translation', 'code review', 'data analysis')"),
      },
      async ({ keyword }) => {
        try {
          const agent = await this.getAcpAgent();
          const results = await agent.browseAgents(keyword);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No agents found for keyword: ${keyword}` }],
            };
          }

          const formatted = results
            .map(
              (a) =>
                `Name: ${a.name}\nAddress: ${a.walletAddress}\nOfferings: ${a.offerings?.map((o) => o.name).join(", ") || "none"}\n`
            )
            .join("\n");

          return {
            content: [{ type: "text", text: `Found ${results.length} agent(s):\n\n${formatted}` }],
          };
        } catch (error) {
          return this.formatError(error);
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
        content: [
          {
            type: "text" as const,
            text: `Daily spending limit of ${DAILY_SPENDING_LIMIT} USDC reached. Try again tomorrow.`,
          },
        ],
        isError: true,
      };
    }
    return null;
  }

  // ─── Error formatting ───
  private formatError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Execution failed: ${message}` }],
      isError: true,
    };
  }
}

export default AcpBridgeAgent.serve("/mcp");
