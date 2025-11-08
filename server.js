// server.js
import express from 'express';
import sqlite3 from 'sqlite3';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
// Importe les constantes de configuration
import { SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_DAY_OF_WEEK } from './config.js';
// Scriote du tirage
// import './draw.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const dbFile = 'winners.db';

// Utilisation de la bibliothèque 'cors' pour gérer les requêtes cross-origin
app.use(cors());

app.use('/archives_rounds_pdf', express.static(path.join(__dirname, 'archives_rounds_pdf')));

// ➡️ Gérer l'instance de la base de données de manière centralisée
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Erreur lors de la connexion à la BDD', err.message);
        return;
    }
    console.log('Connecté à la base de données SQLite.');
});

// Crée les tables si elles n'existent pas
db.serialize(() => {
    // Crée la table pour les gagnants
    db.run(`
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
                newRoundTxHash TEXT
            )
    `, (err) => {
        if (err) console.error('Erreur lors de la création de la table winners', err.message);
    });

    // Crée la table pour le statut du tirage
    db.run(`
        CREATE TABLE IF NOT EXISTS draw_status (
            id INTEGER PRIMARY KEY, 
            status TEXT NOT NULL, 
            lastDrawDate TEXT
        )
    `, (err) => {
        if (err) console.error('Erreur lors de la création de la table draw_status', err.message);
    });

    // Initialise le statut si la table est vide
    db.get('SELECT COUNT(*) AS count FROM draw_status', (err, row) => {
        if (row && row.count === 0) {
            db.run('INSERT INTO draw_status (id, status, lastDrawDate) VALUES (1, ?, ?)', ['termine', new Date().toISOString()]);
        }
    });
});

// Endpoint pour récupérer tous les gagnants (triés du plus récent au plus ancien)
app.get('/winners', (req, res) => {
    const sql = 'SELECT * FROM winners ORDER BY roundId DESC';
    db.all(sql, (err, rows) => {
        if (err) {
            console.error('Erreur lors de la récupération des données', err.message);
            return res.status(500).json({ error: 'Error fetching winners.' });
        }
        res.json(rows);
    });
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
app.get('/api/draw-status', (req, res) => {
    const sql = 'SELECT * FROM draw_status WHERE id = 1';
    db.get(sql, (err, row) => {
        if (err) {
            console.error('Erreur lors de la récupération du statut du tirage', err.message);
            return res.status(500).json({ error: 'Error fetching draw status.' });
        }
        res.json(row || { status: 'termine', lastDrawDate: null });
    });
});

// Démarrer le serveur
app.listen(port, () => {
    console.log(`Serveur d'API écoutant sur http://localhost:${port}`);
});

// Gérer la fermeture de la base de données à l'arrêt du processus
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Fermeture de la connexion à la base de données.');
        process.exit(0);
    });

});
