const express = require("express");
const app = express();

app.use(express.json());

// Home route
app.get("/", (req, res) => {
  res.send("Mahalaxmi Parivahan Website Running ✅");
  });

  // Callback URL
  app.post("/callback", (req, res) => {
    console.log("Callback received:", req.body);
      res.status(200).send({ message: "Callback received successfully" });
      });

      const PORT = process.env.PORT || 3000;
      app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        });