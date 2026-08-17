# opencode-to-openai

Launch an OpenAI compliant API that uses OpenCode as the backend.

## Configuration

Configuration can be provided using CLI flags or a `config.json` file. CLI flags take precedence over configuration file settings. Environment variables are not used for configuration.

### CLI Flags

- `--host <host>`: Host address to bind to (default: `127.0.0.1`).
- `--port <port>`: Port to listen on (default: `8000`).
- `--opencode-url <url>`: URL of the OpenCode server. If omitted, an embedded OpenCode server is spawned automatically.
- `--embeddings-model <model>`: Hugging Face model identifier for embeddings (default: `Xenova/bge-small-en-v1.5`).
- `--embeddings-preload <true|false>`: Whether to preload the embeddings model on startup (default: `false`).
- `-c, --config <path>`: Path to a custom JSON configuration file (default: `./config.json` if it exists).

### Example `config.json`

```json
{
  "host": "127.0.0.1",
  "port": 8000,
  "opencodeUrl": "http://127.0.0.1:4096",
  "embeddingsModel": "Xenova/bge-small-en-v1.5",
  "embeddingsPreload": false
}
```

## License

opencode-to-openai © 2026 by Abhishek Kumar is licensed under CC BY-NC-ND 4.0. To view a copy of this license, visit https://creativecommons.org/licenses/by-nc-nd/4.0/
