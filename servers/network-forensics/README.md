# network-forensics

`network-forensics` provides bounded DNS, TLS, HTTP, and route diagnostics for configured
`allowedHosts`. Active probes are disabled by default. DNS results are pinned into TLS and HTTP
connections, and every redirect target is allowlist-checked again to prevent DNS rebinding and
redirect escapes.

HTTP tools never accept arbitrary headers or credentials and discard response bodies. Proxy
environment inspection removes credentials. Route tracing uses only a detected unprivileged
`traceroute`, `tracepath`, or `tracert` backend; raw packet capture is intentionally absent.
