# GitHub MCP Server

Model Context Protocol (MCP) server for GitHub automation. Enables Javari AI to autonomously create repositories, commit code, and manage GitHub resources.

## Features

- ✅ Create repositories (organization or personal)
- ✅ Batch commit multiple files
- ✅ Create and manage branches
- ✅ Create pull requests
- ✅ Repository status monitoring
- ✅ Rate limit tracking
- ✅ Secure API key authentication
- ✅ Comprehensive logging
- ✅ Health checks

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `GITHUB_TOKEN`: Personal access token with repo permissions
- `MCP_API_KEY`: Secure key for MCP authentication

## Development

```bash
npm run dev
```

## Production

```bash
npm run build
npm start
```

## API Endpoints

### Health Check
```
GET /health
```

### Create Repository
```
POST /api/repos/create
Headers: x-api-key: YOUR_MCP_KEY
Body: {
  "name": "my-app",
  "description": "My application",
  "private": false
}
```

### Commit Files
```
POST /api/repos/:owner/:repo/commit
Headers: x-api-key: YOUR_MCP_KEY
Body: {
  "message": "Initial commit",
  "branch": "main",
  "files": [
    {
      "path": "src/index.ts",
      "content": "console.log('Hello');"
    }
  ]
}
```

### Get Repository Status
```
GET /api/repos/:owner/:repo/status
Headers: x-api-key: YOUR_MCP_KEY
```

### Create Branch
```
POST /api/repos/:owner/:repo/branch
Headers: x-api-key: YOUR_MCP_KEY
Body: {
  "name": "feature-branch",
  "from": "main"
}
```

### Create Pull Request
```
POST /api/repos/:owner/:repo/pr
Headers: x-api-key: YOUR_MCP_KEY
Body: {
  "title": "Add new feature",
  "head": "feature-branch",
  "base": "main",
  "body": "Description of changes"
}
```

### Delete Repository
```
DELETE /api/repos/:owner/:repo
Headers: x-api-key: YOUR_MCP_KEY
Body: {
  "confirm": "repository-name"
}
```

### Rate Limit Status
```
GET /api/rate-limit
Headers: x-api-key: YOUR_MCP_KEY
```

## Security

- All endpoints (except /health) require API key authentication
- Rate limiting: 1000 requests per hour per IP
- GitHub token stored securely in environment variables
- Audit logging for all operations

## Deployment

### Railway (Recommended)

```bash
railway up
```

Configure environment variables in Railway dashboard.

### Docker

```bash
docker build -t crav-mcp-github .
docker run -p 3001:3001 --env-file .env crav-mcp-github
```

## Monitoring

Check server health:
```bash
curl http://localhost:3001/health
```

Check GitHub rate limits:
```bash
curl -H "x-api-key: YOUR_KEY" http://localhost:3001/api/rate-limit
```

## Error Handling

All endpoints return consistent error format:
```json
{
  "error": "Error description",
  "details": "Detailed message"
}
```

## Logs

- `combined.log`: All operations
- `error.log`: Errors only
- Console: Real-time colored output

## License

MIT - CR AudioViz AI
