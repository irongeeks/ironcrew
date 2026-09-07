# Public localhost test PKI

`cert.pem` and `key.pem` are deliberately public, disposable fixtures for local TLS/WSS/SMTP/IMAP tests. They are not deployment credentials. Test clients trust only this explicit fixture certificate; production certificate validation remains enabled. Never deploy this key or add the certificate to a system trust store.
