// server.js
import express from 'express';
import pkg from 'pg';
import cors from 'cors';
// Importe les constantes de configuration
import { SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_DAY_OF_WEEK } from './config.js';

const { Client } = pkg;
const app = express();
const port = process.env.PORT || 3000;

// Utilisation de la bibliothèque 'cors' pour gérer les requêtes cross-origin
app.use(cors());

// ➡️ Gérer l'instance de la base de données de manière centralisée
const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Connexion à la base de données
await db.connect();
console.log('Connecté à la base de données PostgreSQL.');

// Initialisation des tables
await initDatabase();

async function initDatabase() {
    try {
        // Table winners
        await db.query(`
            CREATE TABLE IF NOT EXISTS winners (
                roundId INTEGER PRIMARY KEY,
                winner TEXT NOT NULL,
                bountyTxHash TEXT,
                prizeAmount TEXT,  
                burnAmount TEXT,   
                drawDateUTC TEXT,
                totalTickets INTEGER,
                numberOfParticipants INTEGER,
                newRoundStarted INTEGER,
                newRoundTxHash TEXT,
                pdf_data BYTEA
            )
        `);

        // Table draw_status
        await db.query(`
            CREATE TABLE IF NOT EXISTS draw_status (
                id INTEGER PRIMARY KEY, 
                status TEXT NOT NULL, 
                lastDrawDate TEXT
            )
        `);

        // Initialise le statut si la table est vide
        const result = await db.query('SELECT COUNT(*) AS count FROM draw_status');
        if (parseInt(result.rows[0].count) === 0) {
            await db.query('INSERT INTO draw_status (id, status, lastDrawDate) VALUES (1, $1, $2)', ['termine', new Date().toISOString()]);
        }
    } catch (err) {
        console.error('Erreur lors de l\'initialisation de la base de données:', err.message);
        throw err;
    }
}

// Endpoint pour récupérer tous les gagnants (triés du plus récent au plus ancien)
app.get('/winners', async (req, res) => {
    try {
        const sql = 'SELECT roundId, winner, bountyTxHash, prizeAmount, burnAmount, drawDateUTC, totalTickets, numberOfParticipants, newRoundStarted, newRoundTxHash FROM winners ORDER BY roundId DESC';
        const result = await db.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error('Erreur lors de la récupération des données', err.message);
        return res.status(500).json({ error: 'Error fetching winners.' });
    }
});

// Endpoint pour télécharger les PDF
app.get('/api/pdf/:roundId', async (req, res) => {
    try {
        const roundId = req.params.roundId;
        const sql = 'SELECT pdf_data FROM winners WHERE roundId = $1';
        
        const result = await db.query(sql, [roundId]);
        
        if (!result.rows[0] || !result.rows[0].pdf_data) {
            return res.status(404).json({ error: 'PDF not found for this round' });
        }
        
        // Servir le PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="INKY_Tombola_report_${roundId}.pdf"`);
        res.send(result.rows[0].pdf_data);
    } catch (err) {
        console.error('Erreur récupération PDF:', err.message);
        return res.status(500).json({ error: 'Error fetching PDF' });
    }
});

// Endpoint pour obtenir l'heure du prochain tirage
app.get('/api/draw-info', (req, res) => {
    res.json({
        scheduleHour: SCHEDULE_HOUR,
        scheduleMinute: SCHEDULE_MINUTE,
        scheduleDayOfWeek: SCHEDULE_DAY_OF_WEEK
    });
});

// Endpoint pour obtenir le statut du tirage
app.get('/api/draw-status', async (req, res) => {
    try {
        const sql = 'SELECT * FROM draw_status WHERE id = 1';
        const result = await db.query(sql);
        res.json(result.rows[0] || { status: 'termine', lastDrawDate: null });
    } catch (err) {
        console.error('Erreur lors de la récupération du statut du tirage', err.message);
        return res.status(500).json({ error: 'Error fetching draw status.' });
    }
});

// Démarrer le serveur
app.listen(port, () => {
    console.log(`Serveur d'API écoutant sur http://localhost:${port}`);
});

// Gérer la fermeture de la base de données à l'arrêt du processus
process.on('SIGINT', async () => {
    try {
        await db.end();
        console.log('Fermeture de la connexion à la base de données.');
        process.exit(0);
    } catch (err) {
        console.error('Erreur lors de la fermeture de la connexion:', err.message);
        process.exit(1);
    }
});
