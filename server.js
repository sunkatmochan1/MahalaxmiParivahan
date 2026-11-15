
const express = require("express");
const app = express();

// Temporary, privacy-safe diagnostic logging.
// Never log request bodies, Aadhaar data, JWTs or disclosures.
app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/uidai/callback") {
        console.log("[OVSE] callback_request_received", {
            contentType: req.get("content-type") || "missing"
        });
    }
    next();
});

app.use(express.text({
    type: ["application/xml", "text/xml", "text/plain"],
    limit: "1mb"
}));

app.use(express.json({ limit: "1mb" }));

const { XMLParser, XMLValidator } = require("fast-xml-parser");

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    trimValues: true
});

// Load UIDAI JWKS snapshot from Render environment variable.
let uidaiJwksData;

try {
    uidaiJwksData = JSON.parse(process.env.UIDAI_JWKS_JSON || "");
} catch {
    throw new Error("UIDAI_JWKS_JSON is missing or is not valid JSON");
}

if (
    !uidaiJwksData ||
    !Array.isArray(uidaiJwksData.keys) ||
    uidaiJwksData.keys.length === 0 ||
    uidaiJwksData.keys.some(
        key => !key || typeof key.kid !== "string" || !key.kid
    )
) {
    throw new Error("UIDAI_JWKS_JSON does not contain a valid JWKS key list");
}

const josePromise = import("jose");

const uidaiJwksPromise = josePromise.then(({ createLocalJWKSet }) =>
    createLocalJWKSet(uidaiJwksData)
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
    } catch {
        const networkError = new Error("Cloudflare network request failed");
        networkError.status = 503;
        throw networkError;
    }

    let data;

    try {
        data = await response.json();
    } catch {
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
        throw new Error("Transaction has already expired");
    }

    return transaction;
}

// Receive form-data requests.
app.use(express.urlencoded({ extended: true }));

// Home route.
app.get("/", (req, res) => {
    res.send("Mahalaxmi Parivahan Website Running");
});

app.post("/uidai/callback", async (req, res) => {
    const xml = typeof req.body === "string" ? req.body : "";
    let txnId = "";
    let stage = "request_body_parsed";

    console.log("[OVSE] callback_body_parsed", {
        bodyType: typeof req.body,
        bodyLength: Buffer.isBuffer(req.body)
            ? req.body.length
            : (typeof req.body === "string"
                ? Buffer.byteLength(req.body)
                : 0)
    });

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
        console.warn("[OVSE] callback_rejected", {
            reason: "empty_body"
        });
        return sendAck("", 400, "Empty callback body");
    }

    try {
        stage = "xml_validation";

        const validation = XMLValidator.validate(xml);

        if (validation !== true) {
            console.warn("[OVSE] callback_rejected", {
                stage,
                reason: "invalid_xml"
            });
            return sendAck(txnId, 400, "Invalid XML");
        }

        const parsed = xmlParser.parse(xml);
        const callback = parsed?.Request;

        if (!callback || typeof callback !== "object") {
            console.warn("[OVSE] callback_rejected", {
                stage,
                reason: "invalid_callback_structure"
            });
            return sendAck(txnId, 400, "Invalid callback structure");
        }

        txnId = String(callback?.TxnID || "").trim();
        const credential = String(callback?.Credential || "").trim();

        if (!txnId || !credential) {
            console.warn("[OVSE] callback_rejected", {
                stage,
                reason: "missing_txn_or_credential"
            });
            return sendAck(txnId, 400, "Invalid callback data");
        }

        // Confirm transaction is registered, pending and unexpired.
        stage = "transaction_lookup";
        await getValidTransaction(txnId);
        console.log("[OVSE] transaction_validated");

        // Separate compact JWT and SD-JWT disclosures.
        const parts = credential.split("~");
        const compactJwt = parts.shift();
        const disclosures = parts.filter(Boolean);

        if (!compactJwt || compactJwt.split(".").length !== 3) {
            throw new Error("Invalid SD-JWT format");
        }

        // Verify UIDAI JWT signature.
        stage = "jwt_signature_verification";

        const { jwtVerify } = await josePromise;
        let jwks;

        try {
            jwks = await uidaiJwksPromise;
        } catch (error) {
            console.error(
                "UIDAI JWKS retrieval failed:",
                error.message
            );

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

            console.log("[OVSE] jwt_signature_verified");

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

        const matchedUidaiKey = uidaiJwksData.keys.find(
            key => key.kid === protectedHeader.kid
        );

        if (
            !matchedUidaiKey ||
            matchedUidaiKey.kty !== "RSA" ||
            protectedHeader.alg !== "RS256"
        ) {
            throw new Error("Unexpected UIDAI signing key");
        }

        // Require SHA-256 disclosure hashing.
        stage = "sd_jwt_disclosure_verification";

        if (payload._sd_alg !== "sha-256") {
            throw new Error("Unsupported SD-JWT hash algorithm");
        }

        if (!Array.isArray(payload._sd)) {
            throw new Error("SD-JWT disclosure digest list missing");
        }

        // Collect disclosure digest references recursively.
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

        // Validate disclosures against referenced digests.
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

        console.log("[OVSE] disclosures_verified", {
            count: verifiedDigests.size
        });

        // Report successful verification to Cloudflare.
        stage = "cloudflare_completion";

        await cloudflareRequest("/callbacks/complete", "POST", {
            txn: txnId,
            result: "VERIFIED",
            credential_verified: true
        });

        console.log("[OVSE] cloudflare_completion_succeeded");
        console.log("[OVSE] uidai_credential_verified");

        return sendAck(txnId, 200, "Success");

    } catch (error) {
        // Log only processing stage and error description.
        // Never log credentials or disclosure contents.
        console.error("[OVSE] callback_processing_failed", {
            stage,
            error: error.code || error.message,
            status: error.status || null
        });

        return sendAck(
            txnId,
            error.status >= 500 ? 503 : 400,
            error.status >= 500
                ? "Verification service temporarily unavailable"
                : "Credential verification failed"
        );
    }
});

// Start server.
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
