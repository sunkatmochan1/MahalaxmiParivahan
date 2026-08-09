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
    console.log("UIDAI Response received:", req.body);
      
        // UIDAI needs 200 OK response
          res.status(200).send("OK");
          });

          const PORT = process.env.PORT || 3000;
          app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            });