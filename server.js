const express = require("express");
const app = express();

// Receive JSON, XML and form-data requests
app.use(express.json());
app.use(express.text({ type: ["application/xml", "text/xml", "text/plain"] }));
app.use(express.urlencoded({ extended: true }));

// Home route
app.get("/", (req, res) => {
    res.send("Mahalaxmi Parivahan Website Running");
});

// UIDAI callback route
app.post("/uidai/callback", (req, res) => {
    const xml = typeof req.body === "string" ? req.body : "";

    // Extract transaction ID
    const match = xml.match(/<TxnID>\s*([^<]+)\s*<\/TxnID>/i);

    if (!match) {
        return res.status(400)
            .type("application/xml")
            .send(
                "<Response><ResponseCode>400</ResponseCode><ResponseMsg>Invalid request</ResponseMsg></Response>"
            );
    }

    const txnId = match[1].trim();

    // UIDAI acknowledgement
    const acknowledgement =
        `<Response>
            <TxnID>${txnId}</TxnID>
            <ResponseCode>200</ResponseCode>
            <ResponseMsg>Success</ResponseMsg>
        </Response>`;

    console.log("UIDAI callback received. Transaction ID:", txnId);

    return res.status(200)
        .type("application/xml")
        .send(acknowledgement);
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
