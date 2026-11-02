const express = require("express");
const app = express();

// IMPORTANT: UIDAI sends XML and form data, so add both
app.use(express.json());
app.use(express.text({ type: '*/*' })); // This handles UIDAI XML
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Mahalaxmi Parivahan Website Running ✅");
  });

  // FIXED: Change /callback to /uidai/callback for UIDAI
  app.post("/uidai/callback", (req, res) => {
    const xml = typeof req.body === "string" ? req.body : "";

    // Extract transaction ID without logging the credential
    const match = xml.match(/<TxnID>\s*([^<]+)\s*<\/TxnID>/i);

    if (!match) {
        return res.status(400)
            .type("application/xml")
            .send("<Response><ResponseCode>400</ResponseCode><ResponseMsg>Invalid request</ResponseMsg></Response>");
    }

    const txnId = match[1].trim();

    const acknowledgement =
        `<Response>
            <TxnID>${txnId}</TxnID>
            <ResponseCode>200</ResponseCode>
            <ResponseMsg>Success</ResponseMsg>
        </Response>`;

    console.log("UIDAI callback received. Transaction ID:", txnId);

    res.status(200)
        .type("application/xml")
        .send(acknowledgement);
});
          const PORT = process.env.PORT || 3000;
          app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            });
