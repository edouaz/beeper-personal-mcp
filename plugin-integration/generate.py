#!/usr/bin/env python3
"""Generate a private plugin only after verifying its authenticated MCP endpoint."""
import argparse
import getpass
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import jsonschema

HERE = pathlib.Path(__file__).resolve().parent
EXPECTED = {
    'list_accounts', 'list_chats', 'get_chat', 'search_chats', 'list_messages',
    'search_messages', 'get_unread_conversations', 'get_recent_conversations',
    'prepare_reply_draft', 'prepare_message', 'send_message',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify(endpoint, token):
    url = urllib.parse.urlsplit(endpoint)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('The endpoint must be an HTTPS URL without credentials, query, or fragment.')
    opener = urllib.request.build_opener(NoRedirect())
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26'}
    session = None

    def call(message, expect_response=True):
        nonlocal session
        request_headers = dict(headers)
        if session:
            request_headers['Mcp-Session-Id'] = session
        request = urllib.request.Request(endpoint, json.dumps(message).encode(), request_headers, method='POST')
        with opener.open(request, timeout=20) as response:
            session = response.headers.get('Mcp-Session-Id', session)
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('MCP response is too large.')
            if not expect_response:
                return None
            content_type = response.headers.get_content_type()
        if content_type == 'text/event-stream':
            events = [line[5:].strip() for line in raw.decode().splitlines() if line.startswith('data:')]
            if not events:
                raise ValueError('MCP response had no data event.')
            result = json.loads(events[-1])
        else:
            result = json.loads(raw)
        if result.get('id') != message['id'] or 'error' in result or 'result' not in result:
            raise ValueError('Invalid or unsuccessful MCP response.')
        return result['result']

    init = call({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
        'protocolVersion': '2025-03-26', 'capabilities': {},
        'clientInfo': {'name': 'beeper-plugin-verifier', 'version': '1.0.0'}}})
    headers['MCP-Protocol-Version'] = init['protocolVersion']
    call({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, False)
    result = call({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
    tools = result['tools']
    if result.get('nextCursor') or len(tools) != len(EXPECTED) or {t['name'] for t in tools} != EXPECTED:
        raise ValueError('The MCP tool list differs from the expected confirmed-send tool set.')
    if not all(t.get('annotations', {}).get('readOnlyHint') is (t['name'] not in {'prepare_message', 'send_message'}) for t in tools):
        raise ValueError('MCP tool annotations differ from expected permissions.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((HERE / 'draft/plugin.json').read_text())
    config = {'$schema': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
              'mcpServers': {'beeper': {'type': 'streamable-http', 'url': args.endpoint}}}
    jsonschema.validate(manifest, json.loads((HERE / 'plugin.schema.json').read_text()))
    jsonschema.validate(config, json.loads((HERE / 'mcp.schema.json').read_text()))
    if args.output.exists():
        raise ValueError('Output already exists; choose a new path.')
    token = getpass.getpass('MCP OAuth access token (input hidden): ')
    if not token or '\n' in token or '\r' in token:
        raise ValueError('A valid access token is required.')
    verify(args.endpoint, token)
    with zipfile.ZipFile(args.output, 'x', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('private-beeper-conversations/plugin.json', json.dumps(manifest, indent=2) + '\n')
        archive.writestr('private-beeper-conversations/mcp.json', json.dumps(config, indent=2) + '\n')
        archive.write(HERE / 'draft/skills/beeper-conversations/SKILL.md',
                      'private-beeper-conversations/skills/beeper-conversations/SKILL.md')
    print(f'Authenticated MCP probe succeeded; created {args.output}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, jsonschema.ValidationError, urllib.error.URLError) as exc:
        print(f'Package was not generated: {exc}', file=sys.stderr)
        sys.exit(1)
