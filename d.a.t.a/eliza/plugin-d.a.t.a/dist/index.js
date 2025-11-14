// src/providers/token/tokenInfo.ts
import {
  elizaLogger,
  generateMessageResponse,
  ModelClass,
  stringToUuid,
  getEmbeddingZeroVector
} from "@elizaos/core";
var TokenInfoProvider = class {
  API_URL;
  AUTH_TOKEN;
  DATA_PROVIDER_ANALYSIS;
  constructor(runtime) {
    this.API_URL = runtime.getSetting("DATA_API_KEY");
    this.AUTH_TOKEN = runtime.getSetting("DATA_AUTH_TOKEN");
    this.DATA_PROVIDER_ANALYSIS = runtime.getSetting("DATA_PROVIDER_ANALYSIS") === "true";
  }
  getProviderAnalysis() {
    return this.DATA_PROVIDER_ANALYSIS;
  }
  fetchTokenInfoTemplate() {
    return `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "ticker": "AAVE",
    "platform": "ethereum"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the token query:
- Token ticker (required)
  - Common formats: "AAVE", "$AAVE", "aave", "Aave"
  - Popular tokens: ETH, USDC, USDT, BTC, AAVE, UNI, etc.
  - Remove any $ prefix if present
  - Normalize to uppercase
- Platform/chain to query (optional)
  - Common platforms: ethereum, arbitrum-one, base, opbnb, solana
  - Default to ethereum if not specified
  - Normalize to lowercase

Notes for extraction:
1. Token ticker examples:
   - "$ETH" or "ETH" -> "ETH"
   - "Aave" or "AAVE" -> "AAVE"
   - "usdc" or "USDC" -> "USDC"

2. Platform examples:
   - "Ethereum" or "ETH" -> "ethereum"
   - "Base" -> "base"
   - "Arbitrum" -> "arbitrum-one"
   - "Solana" or "SOL" -> "solana"

3. Context understanding:
   - Look for token names in various formats
   - Consider common token symbols and names
   - Handle both formal and informal token references
   - Extract platform from context if mentioned

4. Special cases:
   - For native tokens like "ETH" on Ethereum, "SOL" on Solana
   - For stablecoins like USDC, USDT that exist on multiple chains
   - For wrapped tokens like WETH, WBTC

Respond with a JSON markdown block containing only the extracted values.`;
  }
  getTokenInfoTemplate() {
    return `
Please analyze the provided token information and generate a comprehensive report. Focus on:

1. Token Overview
- Basic token information (name, symbol, ticker)
- Current price and market status
- Platform availability and deployment

2. Category Analysis
- Primary use cases and sectors
- Ecosystem involvement
- Market positioning

3. Platform Coverage
- Number of supported platforms
- Platform-specific details
- Cross-chain availability

4. Technical Analysis
- Contract deployment status
- Platform-specific characteristics
- Integration capabilities

Please provide a natural language analysis that:
- Uses professional blockchain terminology
- Highlights key features and capabilities
- Provides specific platform details
- Draws meaningful conclusions about token utility
- Includes relevant market context
- Notes any unique characteristics

Token Data:
{{tokenData}}

Query Metadata:
{{queryMetadata}}
`;
  }
  getAnalysisInstruction() {
    return `
            1. Token Overview:
                - Analyze the basic token information
                - Evaluate price and market status
                - Assess platform coverage

            2. Category Analysis:
                - Examine token categories and use cases
                - Analyze ecosystem involvement
                - Evaluate market positioning

            3. Platform Coverage:
                - Analyze deployment across platforms
                - Evaluate cross-chain capabilities
                - Assess platform-specific features

            4. Technical Assessment:
                - Evaluate contract deployments
                - Analyze platform integration
                - Consider technical capabilities

            Please provide a comprehensive analysis of the token based on this information.
            Focus on significant features, capabilities, and insights that would be valuable for understanding the token.
            Use technical blockchain terminology and provide specific examples to support your analysis.
        `;
  }
  /**
   * Query token information by ticker
   * @param ticker The token ticker to query
   * @returns Promise<TokenInfo>
   */
  async queryTokenInfo(ticker) {
    try {
      elizaLogger.log(`Querying token info for ticker: ${ticker}`);
      const startTime = Date.now();
      const url = `${this.API_URL}/token_info?ticker=${encodeURIComponent(ticker.toLowerCase())}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.AUTH_TOKEN ? `${this.AUTH_TOKEN}` : "",
          "Content-Type": "application/json"
        }
      });
      if (!response.ok) {
        throw new Error(
          `API request failed with status ${response.status}`
        );
      }
      const result = await response.json();
      if (result.code !== 0) {
        throw new Error(`API error: ${result.msg}`);
      }
      if (!result.data) {
        throw new Error("No token data returned from API");
      }
      elizaLogger.log(`Successfully retrieved token info for ${ticker}`);
      return result.data;
    } catch (error) {
      elizaLogger.error(
        `Error querying token info for ${ticker}:`,
        error
      );
      throw error;
    }
  }
  /**
   * Validate token info response
   * @param info TokenInfo object to validate
   * @returns boolean
   */
  validateTokenInfo(info) {
    return !!(info.ticker && info.symbol && info.name && info.platform && Array.isArray(info.categories) && Array.isArray(info.contract_infos) && typeof info.price === "number");
  }
  /**
   * Get supported platforms from a token's contract infos
   * @param info TokenInfo object
   * @returns string[] Array of supported platforms
   */
  getSupportedPlatforms(info) {
    return info.contract_infos.map((contract) => contract.platform);
  }
  /**
   * Get contract address for a specific platform
   * @param info TokenInfo object
   * @param platform Platform to get address for
   * @returns string | undefined Contract address if found
   */
  getContractAddress(info, platform) {
    const contract = info.contract_infos.find(
      (c) => c.platform === platform
    );
    return contract?.address;
  }
  async analyzeQuery(queryResult, message, runtime, state) {
    try {
      if (!queryResult?.data) {
        elizaLogger.warn("Invalid query result for analysis");
        return null;
      }
      if (!state) {
        state = await runtime.composeState(message);
      } else {
        state = await runtime.updateRecentMessageState(state);
      }
      const template = this.getTokenInfoTemplate();
      const context = template.replace(
        "{{tokenData}}",
        JSON.stringify(queryResult.data, null, 2)
      ).replace(
        "{{queryMetadata}}",
        JSON.stringify(queryResult.metadata, null, 2)
      );
      const analysisResponse = await generateMessageResponse({
        runtime,
        context,
        modelClass: ModelClass.LARGE
      });
      return typeof analysisResponse === "string" ? analysisResponse : analysisResponse.text || null;
    } catch (error) {
      elizaLogger.error("Error in analyzeQuery:", error);
      return null;
    }
  }
  async processD_A_T_AQuery(runtime, message, state) {
    try {
      const template = this.fetchTokenInfoTemplate();
      const buildContext = template.replace(
        "{{recentMessages}}",
        `User's message: ${message.content.text}`
      );
      if (!state) {
        state = await runtime.composeState(message);
      } else {
        state = await runtime.updateRecentMessageState(state);
      }
      elizaLogger.log(
        "Generating token info query from message:",
        message.content.text
      );
      const preResponse = await generateMessageResponse({
        runtime,
        context: buildContext,
        modelClass: ModelClass.LARGE
      });
      const userMessage = {
        agentId: runtime.agentId,
        roomId: message.roomId,
        userId: message.userId,
        content: message.content
      };
      const preResponseMessage = {
        id: stringToUuid(message.id + "-" + runtime.agentId),
        ...userMessage,
        userId: runtime.agentId,
        content: preResponse,
        embedding: getEmbeddingZeroVector(),
        createdAt: Date.now()
      };
      await runtime.messageManager.createMemory(preResponseMessage);
      await runtime.updateRecentMessageState(state);
      let params = {
        ticker: null,
        platform: null
      };
      let responseText = preResponse;
      if (typeof preResponse === "string") {
        try {
          responseText = JSON.parse(preResponse);
        } catch (e) {
          elizaLogger.error(
            "Failed to parse preResponse as JSON:",
            e
          );
          return null;
        }
      }
      params = responseText;
      elizaLogger.log("preResponse", preResponse);
      elizaLogger.log("responseText:", responseText);
      if (!params.ticker) {
        elizaLogger.error("No ticker found in response");
        return null;
      }
      const startTime = Date.now();
      elizaLogger.log(
        "%%%% D.A.T.A. Querying token info for ticker:",
        params.ticker
      );
      try {
        const tokenInfo = await this.queryTokenInfo(params.ticker);
        const queryResult = {
          success: true,
          data: tokenInfo,
          metadata: {
            queryTime: (/* @__PURE__ */ new Date()).toISOString(),
            queryType: "token",
            executionTime: Date.now() - startTime,
            cached: false,
            queryDetails: {
              params: {
                ticker: params.ticker,
                platform: params.platform
              }
            }
          }
        };
        elizaLogger.log(
          "%%%% D.A.T.A. queryResult:",
          JSON.stringify(queryResult, null, 2)
        );
        const analysisInstruction = this.getAnalysisInstruction();
        const context = `
                    # query by user
                    ${message.content.text}

                    # query result
                    ${JSON.stringify(queryResult, null, 2)}

                    # Analysis Instructions
                    ${analysisInstruction}
                `;
        return {
          context,
          queryResult
        };
      } catch (error) {
        elizaLogger.error("Error querying token info:", {
          error: error.message,
          stack: error.stack,
          ticker: params.ticker
        });
        return null;
      }
    } catch (error) {
      elizaLogger.error("Error in processD_A_T_AQuery:", {
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }
};
var createTokenInfoProvider = (runtime) => {
  return new TokenInfoProvider(runtime);
};
var tokenInfoProvider = {
  get: async (runtime, message, state) => {
    try {
      const provider = createTokenInfoProvider(runtime);
      if (!provider.getProviderAnalysis()) {
        return null;
      }
      const result = await provider.processD_A_T_AQuery(
        runtime,
        message,
        state
      );
      return result ? result.context : null;
    } catch (error) {
      elizaLogger.error("Error in tokenInfoProvider:", error);
      return null;
    }
  }
};

// src/index.ts
var onchainDataPlugin = {
  name: "onchain data plugin",
  description: "Enables onchain data fetching",
  actions: [],
  providers: [tokenInfoProvider],
  evaluators: [],
  services: [],
  clients: []
};
export {
  onchainDataPlugin
};
//# sourceMappingURL=index.js.map