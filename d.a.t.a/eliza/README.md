# @elizaos/plugin-d.a.t.a

> D.A.T.A Framework plugin for Eliza, enabling autonomous blockchain data interaction and analysis.

## Overview

This plugin integrates CARV's D.A.T.A Framework with Eliza, providing AI agents with seamless access to on-chain and off-chain data. It enables autonomous data fetching, analysis, and action execution based on blockchain events and patterns.

## Features

- **Real-time Blockchain Data Access**
  - Transaction fetching and analysis
  - Address monitoring and behavior analysis
  - Gas price tracking and optimization
  - Token transfer monitoring

- **Data Analysis Capabilities**
  - Pattern recognition in transaction flows
  - Anomaly detection in blockchain activity
  - Address behavior profiling
  - Temporal trend analysis

- **AI Agent Integration**
  - Memory management for blockchain data
  - Context-aware query generation
  - Automated response formatting
  - Semantic search capabilities

## Installation

```bash
# Using npm
npm install @elizaos/plugin-d.a.t.a

# Using yarn
yarn add @elizaos/plugin-d.a.t.a

# Using pnpm
pnpm add @elizaos/plugin-d.a.t.a
```

## Configuration

1. Import and register the plugin with Eliza:

```typescript
import { onchainDataPlugin } from '@elizaos/plugin-d.a.t.a';
return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        // character.plugins are handled when clients are added
        plugins: [
            getSecret(character, "DATA_API_KEY") ? onchainDataPlugin : null,
            bootstrapPlugin,
        ]
        providers: [],
        actions: [],
        services: [],
        managers: [],
        cacheManager: cache,
        fetch: logFetch,
    });
```

2. Configure environment variables:

```env
DATA_API_KEY=your_api_key
DATA_AUTH_TOKEN=your_auth_token
```

## API Reference
[D.A.T.A API Document](https://docs.carv.io/d.a.t.a.-ai-framework/api-documentation)

### Project Structure

```
plugin-d.a.t.a/
├── src/
│   ├── actions/
│   │   └── fetchTransaction.ts
│   ├── providers/
│   │   └── ethereum/
│   │       ├── database.ts
│   │       ├── sequelize.ts
│   │       └── txs.ts
│   ├── evaluators/
│   │   └── data_evaluator.ts
│   ├── templates/
│   │   └── index.ts
│   ├── data_service.ts
│   └── index.ts
├── dist/
├── package.json
└── tsconfig.json
```

### Building

```bash
# Build the plugin
npm run build

# Watch mode for development
npm run dev

# Run tests
npm run test
```

## Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## Contributing

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/YourFeature`
3. Commit your changes: `git commit -m 'Add YourFeature'`
4. Push to the branch: `git push origin feature/YourFeature`
5. Submit a pull request

## License

ISC License - see the [LICENSE](LICENSE) file for details.

## Support

For support and questions:
- Open an issue on GitHub
- Join our [Discord community](https://discord.gg/carv)
- Check our [documentation](https://docs.carv.io/d.a.t.a.-ai-framework/introduction)