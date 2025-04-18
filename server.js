require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { OpenAI } = require("openai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY_SIMULATEUR
});

// 🔥 Timeout massimo per OpenAI (320 secondi, come impostato su Vercel)
const API_TIMEOUT = 320000; // 320 secondi (5 min 20 sec)

// Configura axios con un timeout per OpenAI
const axiosInstance = axios.create({
    timeout: API_TIMEOUT // 🔥 Imposta il timeout massimo per tutte le richieste a OpenAI
});

// Endpoint per chiamare diverse API
app.post("/api/:service", async (req, res) => {
    try {
        const { service } = req.params;
        console.log("🔹 Servizio ricevuto:", service);
        console.log("🔹 Dati ricevuti:", JSON.stringify(req.body));
        let apiKey, apiUrl;

        if (service === "openaiSimulateur") {
            // 1) Prepara la connessione SSE
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.flushHeaders(); // forza l’invio degli header

            // 2) Avvia lo streaming dalla SDK OpenAI
            const stream = await openai.chat.completions.create({
                model: req.body.model,
                messages: req.body.messages,
                stream: true
            });

            // 3) Inoltra i delta.content come SSE
            for await (const part of stream) {
                const delta = part.choices?.[0]?.delta?.content;
                if (delta) {
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
                }
            }

            // 4) Una volta finito, estrai il conteggio esatto dei token
            const totalTokens = stream.usage?.total_tokens ?? 0;
            res.write(`data: ${JSON.stringify({ usage: { total_tokens: totalTokens } })}\n\n`);

            // 5) Chiudi il flusso con il DONE
            res.write("data: [DONE]\n\n");
            return res.end();
        }else if (service === "elevenlabs") {
            apiKey = process.env.ELEVENLAB_API_KEY;

            if (!apiKey) {
                console.error("❌ Chiave API ElevenLabs mancante!");
                return res.status(500).json({ error: "Chiave API ElevenLabs mancante" });
            }

            const { text, selectedLanguage } = req.body; // Il frontend deve passare questi dati
            console.log("🔹 Lingua ricevuta dal frontend:", selectedLanguage);

            // ✅ Spostiamo `voiceMap` sopra `voiceId`
            const voiceMap = {
                "espagnol": "l1zE9xgNpUTaQCZzpNJa",
                "français": "1a3lMdKLUcfcMtvN772u",
                "anglais": "7tRwuZTD1EWi6nydVerp"
            };

            const cleanLanguage = selectedLanguage ? selectedLanguage.trim().toLowerCase() : "";
            console.log("🔹 Lingua pulita:", cleanLanguage);

            const voiceId = voiceMap[cleanLanguage];

            if (!voiceId) {
                console.error(`❌ Lingua non supportata: ${cleanLanguage}`);
                return res.status(400).json({ error: "Lingua non supportata" });
            }

            console.log(`✅ Voice ID selezionato: ${voiceId}`);

            apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

            const requestData = {
                text: text,
                model_id: "eleven_flash_v2_5",
                voice_settings: {
                    stability: 0.6,
                    similarity_boost: 0.7,
                    style: 0.1
                }
            };

            console.log("🔹 Dati inviati a ElevenLabs:", requestData);

            try {
                const response = await axios.post(apiUrl, requestData, {
                    headers: {
                        "xi-api-key": apiKey,
                        "Content-Type": "application/json"
                    },
                    responseType: "arraybuffer" // Per restituire l'audio come file
                });

                console.log("✅ Audio ricevuto da ElevenLabs!");
                res.setHeader("Content-Type", "audio/mpeg");
                return res.send(response.data);

            } catch (error) {
                if (error.response) {
                    try {
                        const errorMessage = error.response.data.toString(); // Decodifica il buffer in testo
                        console.error("❌ Errore con ElevenLabs:", errorMessage);
                        res.status(error.response.status).json({ error: errorMessage });
                    } catch (decodeError) {
                        console.error("❌ Errore con ElevenLabs (non decodificabile):", error.response.data);
                        res.status(error.response.status).json({ error: "Errore sconosciuto con ElevenLabs" });
                    }
                } else {
                    console.error("❌ Errore sconosciuto con ElevenLabs:", error.message);
                    res.status(500).json({ error: "Errore sconosciuto con ElevenLabs" });
                }
            }
        }else if (service === "chatbaseSimulateur") {
            const CHATBASE_API_KEY = process.env.CHATBASE_SECRET_KEY;
            const chatbotId = process.env.CHATBASE_AGENT_ID; // Se preferisci metterlo come env, altrimenti hardcoda l’ID
        
            if (!CHATBASE_API_KEY || !chatbotId) {
                console.error("❌ CHATBASE_SECRET_KEY o BOT_ID mancante!");
                return res.status(500).json({ error: "Configurazione Chatbase mancante" });
            }
        
            // 1) Prepara la connessione SSE
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.flushHeaders();
        
            try {
                const response = await fetch("https://www.chatbase.co/api/v1/chat", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${CHATBASE_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        messages: req.body.messages,
                        chatbotId: chatbotId,
                        stream: true
                    })
                });
        
                if (!response.ok || !response.body) {
                    throw new Error("Errore nella richiesta a Chatbase");
                }
        
                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
        
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
        
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split("\n").filter(line => line.trim() !== "");
        
                    for (const line of lines) {
                        if (line === "[DONE]") {
                            res.write(`data: [DONE]\n\n`);
                            return res.end();
                        }
        
                        res.write(`data: ${line}\n\n`);
                    }
                }
            } catch (error) {
                console.error("❌ Errore durante lo streaming Chatbase:", error.message);
                res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
                res.write(`data: [DONE]\n\n`);
                res.end();
            }
        } else {
            return res.status(400).json({ error: "Servizio non valido" });
        }

        const response = await axiosInstance.post(apiUrl, req.body, {
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            }
        });

        res.json(response.data);
    } catch (error) {
        // 🔥 Gestione degli errori di timeout per OpenAI Analyse
        if (error.code === 'ECONNABORTED' && service === "openaiAnalyse") {
            console.error("❌ Timeout della richiesta API OpenAI Analyse.");
            return res.status(504).json({ error: "Timeout nella richiesta a OpenAI Analyse." });
        }

        console.error(`❌ Errore con API ${req.params.service}:`, error.response?.data || error.message);
        res.status(500).json({ error: "Errore nella richiesta API" });
    }
});

// Secure endpoint to obtain a temporary Azure Speech token.
app.get("/get-azure-key", async (req, res) => {
    const apiKey = process.env.AZURE_SPEECH_API_KEY;
    const region = process.env.AZURE_REGION;

    if (!apiKey || !region) {
        return res.status(500).json({ error: "Azure keys missing in the backend" });
    }

    try {
        const tokenRes = await axios.post(
            `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
            null,
            {
                headers: {
                    "Ocp-Apim-Subscription-Key": apiKey
                }
            }
        );

        // We send the token and the region to the frontend.
        res.json({
            token: tokenRes.data,
            region
        });
    } catch (error) {
        console.error("Failed to generate Azure token:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

// ✅ 📌 **Nuovo endpoint per recuperare la chiave di OpenAI**
app.get("/get-openai-key", (req, res) => {
    if (!process.env.OPENAI_API_KEY_ANALYSE) {
        return res.status(500).json({ error: "Chiave API OpenAI mancante nel backend" });
    }

    res.json({
        apiKey: process.env.OPENAI_API_KEY_ANALYSE
    });
});

// Avvia il server
app.listen(port, () => {
    console.log(`Server in esecuzione su http://localhost:${port}`);
});