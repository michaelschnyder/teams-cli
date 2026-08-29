# Contributing

Install Node.js 22.20+, Microsoft Edge or Google Chrome, and the project dependencies.

```bash
npm install
npm run check
npm test
npm run build
```

Keep command handlers small, preserve exact identity and policy checks, and place message-write authorization immediately before the network request. Any new write capability must include a denied-operation test proving that no corresponding network request occurs.

Start with:

- [Architecture](build/architecture.md)
- [Security model](build/security-model.md)
- [Testing strategy](build/testing.md)
- [Research and inspirations](build/inspirations.md)
- [Architecture decisions](build/adr/0001-browser-backed-private-teams-api.md)
