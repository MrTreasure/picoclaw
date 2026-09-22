# Direct channel notifications

`picoclaw notify` sends text through the channel instances already owned by the
running Gateway. It does not start a second channel poller and does not invoke an
LLM turn.

The command reads the Gateway's ephemeral bearer token from
`$PICOCLAW_HOME/.picoclaw.pid`. The token is regenerated on every Gateway start
and is never copied into the script, target configuration, logs, or repository.

## Quick usage

The host wrapper is `scripts/muse-notify.sh`:

```bash
scripts/muse-notify.sh "Build completed"
printf '%s\n' "Build completed" | scripts/muse-notify.sh
scripts/muse-notify.sh --target weixin:USER_ID "Build completed"
scripts/muse-notify.sh \
  --target weixin:USER_ID \
  --target pico:SESSION_ID \
  "Build completed"
```

With no explicit target, the command uses the default group in
`$PICOCLAW_HOME/notify-targets.json`. If that file does not exist, it safely
falls back only when exactly one recipient exists in the persisted Weixin
context-token store.

## Named multi-channel groups

Recipient IDs are routing metadata, not channel credentials. Keep the local
target file outside Git and mode `0600`:

```json
{
  "default": "owner",
  "groups": {
    "owner": [
      { "channel": "weixin", "to": "USER_ID" },
      { "channel": "pico", "to": "SESSION_ID" }
    ],
    "operations": [
      { "channel": "telegram", "to": "CHAT_ID" }
    ]
  }
}
```

Send to one or more named groups:

```bash
scripts/muse-notify.sh --group owner --group operations "Deployment finished"
```

Any enabled text channel can be addressed. The Gateway validates its temporary
control token, uses the existing channel worker, applies channel message-length
splitting and retry rules, and returns a non-zero status if delivery fails.
