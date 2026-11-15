<?php

use App\Http\Middleware\McpAuthenticate;
use App\Mcp\IratkapuServer;
use Laravel\Mcp\Facades\Mcp;

// AI-kapcsolat (ADR-012). Helyi Claude: `php artisan mcp:start iratkapu`, a tokennel az IRATKAPU_MCP_TOKEN változóban.
Mcp::local('iratkapu', IratkapuServer::class);

// Távoli kapcsolat (Claude Code, ChatGPT- és claude.ai-connector): személyes MCP-token vagy OAuth 2.1.
Mcp::oauthRoutes();
Mcp::web('/mcp', IratkapuServer::class)->middleware([McpAuthenticate::class, 'throttle:120,1']);
