# HTTP/SSE Deployment Guide

This guide covers deploying the cc-obsidian-mem MCP server as an HTTP/SSE service with Traefik reverse proxy and Cloudflare Access OAuth 2.0 authentication.

## Overview

The HTTP server supports:

| Feature | Description |
|---------|-------------|
| **Streamable HTTP** | Modern MCP transport (recommended) |
| **Legacy SSE** | Backwards compatibility |
| **Cloudflare Access OAuth 2.0** | Enterprise authentication via RFC 9728 |
| **Bearer Token** | Simple token authentication |

## Quick Start

### 1. Clone and Configure

```bash
cd plugin

# Copy example environment file
cp .env.example .env

# Edit .env with your settings
nano .env
```

### 2. Required Environment Variables

```bash
# Path to your Obsidian vault
VAULT_PATH=/path/to/your/obsidian/vault

# Domain for Traefik routing
DOMAIN=obsidian-mem.yourdomain.com

# Public URL (for OAuth metadata)
RESOURCE_URL=https://obsidian-mem.yourdomain.com

# Authentication mode: 'bearer', 'cloudflare', or 'both'
AUTH_MODE=both
```

### 3. Deploy with Docker Compose

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f
```

## Authentication Modes

### Bearer Token (Simple)

For simple deployments or API access:

```bash
AUTH_MODE=bearer
BEARER_TOKEN=$(openssl rand -base64 32)
```

### Cloudflare Access (OAuth 2.0)

For enterprise authentication with Zero Trust:

```bash
AUTH_MODE=cloudflare
CF_ACCESS_TEAM=your-team-name
CF_ACCESS_AUD=your-application-audience-tag
```

### Both (Recommended)

Accept either authentication method:

```bash
AUTH_MODE=both
BEARER_TOKEN=your-token
CF_ACCESS_TEAM=your-team-name
CF_ACCESS_AUD=your-application-audience-tag
```

## Cloudflare Access Setup

### Step 1: Create Access Application

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access → Applications → Add an application**
3. Select **Self-hosted**
4. Configure:
   - **Application name**: Obsidian Memory MCP
   - **Session duration**: 24 hours
   - **Application domain**: `obsidian-mem.yourdomain.com`

### Step 2: Configure Policies

1. Add a policy for allowed users:
   - **Policy name**: Allow Team
   - **Action**: Allow
   - **Include**: Emails ending in `@yourdomain.com`

2. (Optional) Add bypass for monitoring:
   - **Policy name**: Uptime Kuma Bypass
   - **Action**: Bypass
   - **Include**: IP range `your-monitoring-server-ip/32`
   - **Important**: Place bypass policy ABOVE allow policy

### Step 3: Get Configuration Values

1. **Application Audience (AUD) Tag**:
   - Click on your application
   - Find "Application Audience (AUD) Tag" in Overview
   - Copy to `CF_ACCESS_AUD`

2. **Team Name**:
   - Go to Settings → Custom Pages
   - Your team domain is: `https://[team-name].cloudflareaccess.com`
   - Copy `[team-name]` to `CF_ACCESS_TEAM`

### Step 4: Verify Setup

```bash
# Test OAuth metadata endpoint
curl https://obsidian-mem.yourdomain.com/.well-known/oauth-protected-resource

# Should return:
{
  "resource": "https://obsidian-mem.yourdomain.com",
  "authorization_servers": ["https://your-team.cloudflareaccess.com"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["mcp:read", "mcp:write", "mcp:tools"],
  "mcp_protocol_version": "2025-03-26",
  "resource_type": "mcp-server"
}
```

## Endpoints

| Endpoint | Method | Auth Required | Description |
|----------|--------|---------------|-------------|
| `/.well-known/oauth-protected-resource` | GET | No | RFC 9728 OAuth metadata |
| `/health` | GET | No | Health check |
| `/mcp` | GET, POST, DELETE | Yes | Streamable HTTP transport |
| `/sse` | GET | Yes | Legacy SSE connection |
| `/messages` | POST | Yes | Legacy message endpoint |

## Claude Integration

### Claude.ai (Web) with Cloudflare Access

When using Cloudflare Access, authentication happens at the Cloudflare layer. Configure Claude.ai with just the URL:

```json
{
  "mcpServers": {
    "obsidian-mem": {
      "transport": "http",
      "url": "https://obsidian-mem.yourdomain.com/mcp"
    }
  }
}
```

**Note**: You'll be redirected to Cloudflare Access login when first connecting.

### Claude.ai (Web) with Bearer Token

```json
{
  "mcpServers": {
    "obsidian-mem": {
      "transport": "http",
      "url": "https://obsidian-mem.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "obsidian-mem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/client-http",
        "https://obsidian-mem.yourdomain.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add obsidian-mem https://obsidian-mem.yourdomain.com/mcp \
  --bearer-token YOUR_TOKEN_HERE
```

## Traefik Integration

### Prerequisites

- Traefik running with Docker provider
- External network named `traefik_proxy`
- Certificate resolver configured (e.g., `letsencrypt`)

### Create Traefik Network

```bash
docker network create traefik_proxy
```

### Traefik Labels

The docker-compose.yml includes:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.obsidian-mem.rule=Host(`obsidian-mem.example.com`)"
  - "traefik.http.routers.obsidian-mem.entrypoints=websecure"
  - "traefik.http.routers.obsidian-mem.tls.certresolver=letsencrypt"
  - "traefik.http.services.obsidian-mem.loadbalancer.server.port=8080"
```

## Security

### RFC 9728 Compliance

The server implements RFC 9728 (OAuth Protected Resource Metadata):

- `/.well-known/oauth-protected-resource` endpoint
- `WWW-Authenticate` header with resource metadata link
- Proper 401 responses for unauthorized requests

### Cloudflare Access JWT Validation

When using Cloudflare Access:

1. Cloudflare adds `CF-Access-JWT-Assertion` header
2. Server validates JWT against Cloudflare's public keys
3. JWT contains user identity (email, etc.)
4. Automatic key rotation via JWKS endpoint

### CORS Configuration

```bash
ALLOWED_ORIGINS=https://claude.ai,https://your-app.com
```

### TLS/HTTPS

Always use HTTPS in production:
- Traefik handles TLS termination
- Let's Encrypt for automatic certificates
- Cloudflare provides additional DDoS protection

## Monitoring

### Health Check

```bash
curl https://obsidian-mem.yourdomain.com/health

# Response:
{
  "status": "healthy",
  "name": "obsidian-mem",
  "version": "0.3.0",
  "timestamp": "2026-01-11T00:00:00.000Z",
  "auth_mode": "both"
}
```

### Uptime Kuma

Docker labels auto-configure Uptime Kuma:

```yaml
labels:
  - kuma.obsidian-mem.http.name=Obsidian Memory MCP
  - kuma.obsidian-mem.http.url=https://obsidian-mem.yourdomain.com/health
  - kuma.obsidian-mem.http.interval=60
```

**Important**: Add IP bypass in Cloudflare Access for monitoring server.

## Troubleshooting

### Authentication Failures

```bash
# Check OAuth metadata
curl -v https://obsidian-mem.yourdomain.com/.well-known/oauth-protected-resource

# Test with bearer token
curl -H "Authorization: Bearer $TOKEN" https://obsidian-mem.yourdomain.com/health

# Check Cloudflare Access configuration
curl -v https://your-team.cloudflareaccess.com/cdn-cgi/access/certs
```

### CORS Issues

Ensure origin is in `ALLOWED_ORIGINS` and `CF-Access-JWT-Assertion` header is allowed:

```bash
ALLOWED_ORIGINS=https://claude.ai,https://your-custom-origin.com
```

### Container Issues

```bash
# Check logs
docker compose logs obsidian-mem

# Verify environment
docker compose exec obsidian-mem env | grep -E "(AUTH|CF_)"

# Restart
docker compose restart obsidian-mem
```

## Local Development

### Run Without Docker

```bash
cd plugin
bun install

# Set environment variables
export AUTH_MODE=bearer
export BEARER_TOKEN=dev-token
export CC_OBSIDIAN_MEM_VAULT_PATH=/path/to/vault

# Run in development
bun run dev:http
```

### Build for Production

```bash
bun run build:http
bun run start:http
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAULT_PATH` | Yes | - | Host path to Obsidian vault |
| `DOMAIN` | Yes | - | Public domain for Traefik |
| `RESOURCE_URL` | Recommended | - | Public URL for OAuth metadata |
| `AUTH_MODE` | No | `bearer` | `bearer`, `cloudflare`, or `both` |
| `BEARER_TOKEN` | Conditional | - | Required if AUTH_MODE includes bearer |
| `CF_ACCESS_TEAM` | Conditional | - | Required if AUTH_MODE includes cloudflare |
| `CF_ACCESS_AUD` | Conditional | - | Required if AUTH_MODE includes cloudflare |
| `MEM_FOLDER` | No | `_claude-mem` | Folder within vault |
| `ALLOWED_ORIGINS` | No | `https://claude.ai` | CORS allowed origins |
| `CERT_RESOLVER` | No | `letsencrypt` | Traefik cert resolver |
| `TZ` | No | `America/New_York` | Container timezone |

## Architecture

```
User
  ↓
Cloudflare Edge (DDoS protection, TLS)
  ↓
Cloudflare Access (OAuth 2.0 authentication)
  ↓
Traefik (Reverse proxy, TLS termination)
  ↓
obsidian-mem container (MCP server)
  ↓
Obsidian Vault (mounted volume)
```
