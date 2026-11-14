const express = require("express");
const app = express();
app.use(express.text({
    type: ["application/xml", "text/xml", "text/plain"],
    limit: "1mb"
}));
app.use(express.json({ limit: "1mb" }));
const { XMLParser, XMLValidator } = require("fast-xml-parser");

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    trimValues: true,
});

const UIDAI_JWKS_URL =
    "https://pehchaan.uidai.gov.in/.well-known/jwks.json";

const UIDAI_KEY_ID =
    "uidai-37a8e742-c375-443c-8ce5-8b7a0822cb6b";

const josePromise = import("jose");

const uidaiJwksPromise = josePromise.then(({ createRemoteJWKSet }) =>
    createRemoteJWKSet(
        new URL(UIDAI_JWKS_URL),
        {
            timeoutDuration: 5000,
            cooldownDuration: 30000,
            cacheMaxAge: 600000
        }
    )
);

const CLOUDFLARE_API_URL =
    "https://mahalaxmi-ovse-api.mahalaxmiparivahanpvtltd.workers.dev";

const CLOUDFLARE_API_SECRET = process.env.OVSE_API_SECRET;

async function cloudflareRequest(path, method = "GET", body = null) {
    if (!CLOUDFLARE_API_SECRET) {
        throw new Error("Cloudflare API secret is not configured");
    }

    const options = {
        method,
        headers: {
            "Authorization": `Bearer ${CLOUDFLARE_API_SECRET}`,
            "Content-Type": "application/json"
        }
    };

    if (body !== null) {
        options.body = JSON.stringify(body);
    }

    let response;

    try {
        response = await fetch(
            `${CLOUDFLARE_API_URL}${path}`,
            options
        );
    } catch (error) {
        const networkError = new Error("Cloudflare network request failed");
        networkError.status = 503;
        throw networkError;
    }
    let data;

    try {
        data = await response.json();
    } catch (error) {
        const parseError = new Error("Invalid response from Cloudflare");
        parseError.status =
            response.ok || response.status >= 500
                ? 503
                : response.status;
        throw parseError;
    }

    if (!response.ok) {
        const error = new Error(
            `Cloudflare API error: HTTP ${response.status}`
        );

        error.status = response.status;
        throw error;
    }

    return data;
}

async function getValidTransaction(txnId) {
    const transaction = await cloudflareRequest(
        `/transactions/${encodeURIComponent(txnId)}`
    );

    const now = Math.floor(Date.now() / 1000);

    if (transaction.txn !== txnId) {
        throw new Error("Transaction ID mismatch");
    }

    if (transaction.status !== "PENDING") {
        throw new Error("Transaction is not pending");
    }

    if (transaction.expires_at <= now) {
        throw new Error("Transaction has expired");
    }

    return transaction;
}

// Receive JSON, XML and form-data requests
app.use(express.urlencoded({ extended: true }));

// Home route
app.get("/", (req, res) => {
    res.send("Mahalaxmi Parivahan Website Running");
});

app.post("/uidai/callback", async (req, res) => {
    const xml = typeof req.body === "string" ? req.body : "";
    let txnId = "";

    const sendAck = (txnId, code, message) => {
        const safeTxn = String(txnId || "").replace(/[<>&"']/g, "");
        const safeMessage = String(message).replace(/[<>&"']/g, "");

        return res.status(200)
            .type("application/xml")
            .send(
                `<Response>
                    <TxnID>${safeTxn}</TxnID>
                    <ResponseCode>${code}</ResponseCode>
                    <ResponseMsg>${safeMessage}</ResponseMsg>
                </Response>`
            );
    };
    if (!xml.trim()) {
        return sendAck("", 400, "Empty callback body");
    }  

    try {
        const validation = XMLValidator.validate(xml);

        if (validation !== true) {
           return sendAck(txnId, 400, "Invalid XML");
       }
        const parsed = xmlParser.parse(xml);
        const callback = parsed?.Request;
        if (!callback || typeof callback !== "object") {
           return sendAck(txnId, 400, "Invalid callback structure");
       }

        txnId = String(callback?.TxnID || "").trim();
        const credential = String(callback?.Credential || "").trim();

        if (!txnId || !credential) {
            return sendAck(txnId, 400, "Invalid callback data");
        }

        // Confirm transaction is registered, pending and unexpired
        await getValidTransaction(txnId);

        // Separate compact JWT and SD-JWT disclosures
        const parts = credential.split("~");
        const compactJwt = parts.shift();
        const disclosures = parts.filter(Boolean);

        if (!compactJwt || compactJwt.split(".").length !== 3) {
            throw new Error("Invalid SD-JWT format");
        }

        // Verify UIDAI JWT signature
        const { jwtVerify } = await josePromise;
        let jwks;

        try {
            jwks = await uidaiJwksPromise;
        } catch (error) {
            console.error("UIDAI JWKS retrieval failed:", error.message);
            return sendAck(
                txnId, 
                503,
                "UIDAI verification service temporarily unavailable"
            );
        }

               let payload;
        let protectedHeader;

        try {
            const verified = await jwtVerify(
                compactJwt,
                jwks,
                { algorithms: ["RS256"] }
            );

            payload = verified.payload;
            protectedHeader = verified.protectedHeader;

        } catch (error) {
            console.error(
                "UIDAI JWT verification failed:",
                error.code || error.message
            );

            if (
                error.code === "ERR_JWKS_TIMEOUT" ||
                error.code === "ERR_JWKS_FETCH" ||
                error.name === "TypeError"
            ) {
                return sendAck(
                    txnId,
                    503,
                    "UIDAI verification service temporarily unavailable"
                );
            }

            throw error;
        }
        if (protectedHeader.kid !== UIDAI_KEY_ID) {
            throw new Error("Unexpected UIDAI signing key");
        }

        // Require SHA-256 disclosure hashing
        if (payload._sd_alg !== "sha-256") {
            throw new Error("Unsupported SD-JWT hash algorithm");
        }

        if (!Array.isArray(payload._sd)) {
            throw new Error("SD-JWT disclosure digest list missing");
        }

        // Collect disclosure digest references recursively
        const collectDigests = (value, output) => {
            if (!value || typeof value !== "object") return;

            if (Array.isArray(value)) {
                for (const item of value) {
                    collectDigests(item, output);
                }
                return;
            }

            if (Array.isArray(value._sd)) {
                for (const digest of value._sd) {
                    if (typeof digest === "string") {
                        output.add(digest);
                    }
                }
            }

            for (const [key, item] of Object.entries(value)) {
                if (key !== "_sd") {
                    collectDigests(item, output);
                }
            }
        };

        const referencedDigests = new Set();
        collectDigests(payload, referencedDigests);

        const pendingDisclosures = disclosures.map(disclosure => {
            const digest = require("crypto")
                .createHash("sha256")
                .update(disclosure, "ascii")
                .digest("base64url");

            let decoded;

            try {
                decoded = JSON.parse(
                    Buffer.from(disclosure, "base64url").toString("utf8")
                );
            } catch {
                throw new Error("Invalid disclosure encoding");
            }

            if (
                !Array.isArray(decoded) ||
                (decoded.length !== 2 && decoded.length !== 3)
            ) {
                throw new Error("Invalid disclosure structure");
            }

            return { digest, decoded };
        });

        // Validate each disclosure against a referenced digest.
        // Nested disclosures may introduce further digest references.
        const verifiedDigests = new Set();
        let remaining = [...pendingDisclosures];

        while (remaining.length > 0) {
            const next = [];

            for (const disclosure of remaining) {
                if (verifiedDigests.has(disclosure.digest)) {
                    throw new Error("Duplicate disclosure");
                }

                if (referencedDigests.has(disclosure.digest)) {
                    verifiedDigests.add(disclosure.digest);
                    collectDigests(disclosure.decoded, referencedDigests);
                } else {
                    next.push(disclosure);
                }
            }

            if (next.length === remaining.length) {
                throw new Error("Disclosure digest verification failed");
            }

            remaining = next;
        }

        if (verifiedDigests.size !== disclosures.length) {
            throw new Error("Not all disclosures were verified");
        }

        // Report successful verification to Cloudflare
        await cloudflareRequest("/callbacks/complete", "POST", {
            txn: txnId,
            result: "VERIFIED",
            credential_verified: true
        });

        console.log("UIDAI credential successfully verified for transaction:", txnId);

        return sendAck(txnId, 200, "Success");

    } catch (error) {
        // Do not log the credential or disclosure contents
        console.error("UIDAI callback verification failed:", error.message);

        return sendAck(
            txnId,
            error.status >= 500 ? 503 : 400,
            error.status >= 500
                ? "Verification service temporarily unavailable"
                : "Credential verification failed"
       );
    }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
