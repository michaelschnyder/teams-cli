# Contributing

Install Node.js 22.20+, Microsoft Edge or Google Chrome, and the project dependencies.

```bash
npm install
npm run check
npm test
npm run build
npm run package:check
npm run package:smoke
```

Keep command handlers small, preserve exact identity and policy checks, and place message-write authorization immediately before the network request. Any new write capability must include a denied-operation test proving that no corresponding network request occurs.

Start with:

- [Architecture](docs/build/architecture.md)
- [Security model](docs/build/security-model.md)
- [Testing strategy](docs/build/testing.md)
- [Research and inspirations](docs/build/inspirations.md)
- [Architecture decisions](docs/build/adr/0001-browser-backed-private-teams-api.md)
- [Release process](docs/releasing.md)
