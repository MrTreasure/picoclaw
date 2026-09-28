#!/usr/bin/env python3
"""Public Zhihu/global search; credentials read at runtime, never printed."""
import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import yaml


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', choices=['zhihu', 'global'])
    parser.add_argument('--query', required=True)
    parser.add_argument('--count', type=int, default=5, choices=range(1, 21))
    args = parser.parse_args()
    if not args.query.strip():
        parser.error('query must not be empty')
    try:
        config = yaml.safe_load((pathlib.Path.home() / '.secrets/passwords.yml').read_text())['zhihu']
        secret = config['access_secret']
        if not secret:
            raise ValueError('missing secret')
    except Exception:
        print(json.dumps({'ok': False, 'error': 'ZH_AUTH_CONFIG_UNAVAILABLE', 'fallback': 'web_search (Tavily)'}))
        return 1
    query = urllib.parse.urlencode({'Query': args.query, 'Count': args.count})
    url = 'https://developer.zhihu.com/api/v1/content/' + args.source + '_search?' + query
    request = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + secret,
        'X-Request-Timestamp': str(int(time.time())),
        'Content-Type': 'application/json',
    })
    # Never forward credentials through redirects to another origin.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as response:
            data = json.load(response)
        if data.get('Code') != 0:
            print(json.dumps({'ok': False, 'code': data.get('Code'), 'error': 'ZH_API_REJECTED', 'fallback': 'web_search (Tavily)'}))
            return 1
        print(json.dumps({'ok': True, 'source': args.source, 'data': data.get('Data')}, ensure_ascii=False))
        return 0
    except urllib.error.HTTPError as error:
        print(json.dumps({'ok': False, 'http_status': error.code, 'fallback': 'web_search (Tavily)'}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'ZH_REQUEST_FAILED', 'fallback': 'web_search (Tavily)'}))
    return 1


if __name__ == '__main__':
    sys.exit(main())
