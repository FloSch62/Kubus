`localhost.crt` and `localhost.key` are public test credentials, used only by the
isolated loopback HTTPS server in `cluster-tls.spec.ts`. They authenticate both
ends of that test's mTLS connection. They must never be used outside tests.
