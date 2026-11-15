<?php

// AI-kapcsolat (ADR-012): az OAuth dinamikus kliensregisztrációja csak ezekre a visszatérési címekre enged
// (ChatGPT-, claude.ai-connector, valamint a helyi Claude Code / Claude Desktop a saját gépen).
return [

    'redirect_domains' => array_values(array_filter(array_map('trim', explode(',', (string) env('MCP_REDIRECT_DOMAINS',
        'https://chatgpt.com,https://chat.openai.com,https://claude.ai,https://claude.com,http://localhost,http://127.0.0.1'))))),

    'custom_schemes' => [],

    // MCP-közvetítő (ADR-013): a nyilvános cím, ahol a ChatGPT a helyi módú KapuMailt éri el (https://…/<azonosító>/mcp).
    'relay_url' => env('MCP_RELAY_URL', 'https://mcp.kapumail.hu'),

    'authorization_server' => null,

    'allowed_origins' => array_values(array_filter(array_map('trim', explode(',', (string) env('MCP_ALLOWED_ORIGINS',
        'https://chatgpt.com,https://chat.openai.com,https://claude.ai,https://claude.com'))))),

    'tool_search' => [
        'max_tool_calls' => 10,
        'max_output_bytes' => 65_536,
    ],

    'clients' => [],

];
