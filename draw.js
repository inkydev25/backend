// draw.js
import dotenv from "dotenv";
import { ethers, getBytes } from "ethers";
import fs from "fs";
import PDFDocument from "pdfkit";
import sqlite3 from 'sqlite3';
import cron from 'node-cron';
import { SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_DAY_OF_WEEK } from './config.js';

dotenv.config();

// ===================== CONFIG =====================
const BATCH_SIZE = 50000;
const POLL_INTERVAL = 15 * 1000;
const CONFIRMATIONS = 3;
const ETH_BLOCKS_N = 5;
const MIN_PARTICIPANTS = 5;
// CONSTANTES POUR LA GESTION DES FONDS
const EXTERNAL_WALLET = "0x20dd4f9857A737E4b762bB8857499e22CdA70Edc"; // Adresse du Bounty Wallet
const INKY_ADDRESS = "0x6EB2C1fE4e3B48af4905A0209658810B61343438";
const BURN_DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const TICKET_SALE_ADDRESS = "0x9904D652640074949E7063a3a172c174c13c6165";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Clé privée de l'Owner (pour tout signer)

if (!PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY not defined in .env");
}

// TICKET_SALE_ABI MIS À JOUR POUR LE NOUVEAU CONTRAT
const TICKET_SALE_ABI = [
    "function currentRoundId() view returns (uint256)",
    "function transferBountyToWinner(address winner) external", 
    "function startNewRound() external",
    "function getRoundStats(uint256 _roundId) external view returns (tuple(uint256 currentRoundId, uint256 totalParticipants, uint256 totalTickets, uint256 roundBurned, uint256 allTimeBurned, uint256 poolBalance, uint256 maxBounty, uint256 ticketPrice, uint256 minBalanceToParticipate))",
    "function maxBountyAmountINKY() view returns (uint256)",
    "function setMaxBounty(uint256 _newMaxBounty) external",
    "event TicketsPurchased(address indexed buyer, uint256 amount, uint256 totalCost, uint256 roundId)",
    "event BountyTransferred(uint256 roundId, address indexed winner, uint256 prizeAmount, uint256 burnAmount)", 
    "event NewRoundStarted(uint256 newRoundId)"
];

// ABI du token INKY
const INKY_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)", 
    "function allowance(address owner, address spender) view returns (uint256)" 
];

// ===================== PROVIDERS & DB =====================
const nexeraProvider = new ethers.JsonRpcProvider("https://rpc.testnet.nexera.network");
const inkyContract = new ethers.Contract(INKY_ADDRESS, INKY_ABI, nexeraProvider);
const ticketSaleContract = new ethers.Contract(TICKET_SALE_ADDRESS, TICKET_SALE_ABI, nexeraProvider);

const db = new sqlite3.Database('winners.db', (err) => {
    if (err) {
        console.error('Erreur lors de la connexion à la BDD', err.message);
    } else {
        console.log('Connecté à la base de données SQLite pour le tirage.');
        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS draw_status (
                    id INTEGER PRIMARY KEY, 
                    status TEXT NOT NULL, 
                    lastDrawDate TEXT
                )
            `);
       
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
            `);
            db.get('SELECT COUNT(*) AS count FROM draw_status', (err, row) => {
                if (row && row.count === 0) {
                    db.run('INSERT INTO draw_status (id, status, lastDrawDate) VALUES (1, ?, ?)', ['termine', new Date().toISOString()]);
                }
            });
        });
    }
});

// ➡️ Fonctions utilitaires de BDD
function runDB(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve(this.changes);
        });
    });
}

function getDB(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function setDrawStatus(status) {
    try {
        const date = new Date().toISOString();
        const sql = 'UPDATE draw_status SET status = ?, lastDrawDate = ? WHERE id = 1';
        await runDB(sql, [status, date]);
        console.log(`Statut du tirage mis à jour: ${status}`);
    } catch (err) {
        console.error('Erreur lors de la mise à jour du statut', err.message);
        throw err;
    }
}

async function checkBountyBalance() {
    try {
        const balanceBN = await inkyContract.balanceOf(EXTERNAL_WALLET);
        const decimals = await inkyContract.decimals();
        return { 
            balanceBN, 
            balanceFormatted: parseFloat(ethers.formatUnits(balanceBN, decimals)),
            decimals
        };
    } catch (err) {
        console.error("Erreur lors de la vérification du solde du bounty wallet :", err.message);
        return { balanceBN: BigInt(0), balanceFormatted: 0, decimals: 18 };
    }
}

// ===================== CORE FUNCTIONS =====================
async function getCurrentRound() {
    const roundId = await ticketSaleContract.currentRoundId();
    return Number(roundId);
}

async function getRoundStats(roundId) {
    try {
        const stats = await ticketSaleContract.getRoundStats(roundId);
        return {
            currentRoundId: Number(stats.currentRoundId),
            totalParticipants: Number(stats.totalParticipants),
            totalTickets: Number(stats.totalTickets),
            roundBurned: stats.roundBurned,
            allTimeBurned: stats.allTimeBurned,
            poolBalance: stats.poolBalance,
            maxBounty: stats.maxBounty,
            ticketPrice: Number(stats.ticketPrice),
            minBalanceToParticipate: Number(stats.minBalanceToParticipate)
        };
    } catch (err) {
        console.error("Erreur lors de la récupération des stats du round:", err.message);
        throw err;
    }
}

async function fetchTickets(roundId) {
    const filter = ticketSaleContract.filters.TicketsPurchased();
    const latestBlock = await nexeraProvider.getBlockNumber();
    let fromBlock = 0;
    const tickets = [];
    
    while (fromBlock <= latestBlock) {
        const toBlock = Math.min(fromBlock + BATCH_SIZE, latestBlock);
        const logs = await ticketSaleContract.queryFilter(filter, fromBlock, toBlock);

        logs.forEach(log => {
            const { buyer, amount, roundId: rId } = log.args;
            if (BigInt(rId) === BigInt(roundId)) {
                for (let i = 0; i < amount; i++) {
                    tickets.push(buyer);
                }
            }
        });
        fromBlock = toBlock + 1;
    }
    console.log(`Total tickets for round ${roundId}:`, tickets.length);
    return tickets;
}

async function waitForConfirmedEthBlocks(timestamp, n = ETH_BLOCKS_N) {
    console.log(`⏱ Waiting for ${n} confirmed Nexera blocks after ${new Date(timestamp * 1000).toUTCString()}...`);
    const blocks = [];

    while (blocks.length < n) {
        try {
            const latestBlock = await nexeraProvider.getBlock("latest");
            let low = 0, high = latestBlock.number;
            let firstBlock = null;
            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const block = await nexeraProvider.getBlock(mid);
                if (!block) break;
                if (block.timestamp >= timestamp) {
                    firstBlock = block;
                    high = mid - 1;
                } else {
                    low = mid + 1;
                }
            }

            if (!firstBlock) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                continue;
            }

            blocks.length = 0;
            let currentNumber = firstBlock.number;
            while (blocks.length < n) {
                const blk = await nexeraProvider.getBlock(currentNumber);
                if (!blk) break;
                if (blk.number + CONFIRMATIONS <= latestBlock.number) {
                    blocks.push(blk);
                } else {
                    break;
                }
                currentNumber++;
            }

            if (blocks.length < n) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
            }
        } catch (err) {
            console.log("Error fetching NXRA blocks:", err.message);
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
        }
    }

    return blocks.map(b => b.hash);
}

async function executeContractTransfer(winner) {
    const wallet = new ethers.Wallet(PRIVATE_KEY, nexeraProvider);
    const contractWithSigner = new ethers.Contract(TICKET_SALE_ADDRESS, TICKET_SALE_ABI, wallet);
    
    // Vérification de l'allowance
    const bountyData = await checkBountyBalance(); 
    const allowanceBN = await inkyContract.allowance(EXTERNAL_WALLET, TICKET_SALE_ADDRESS); 
    
    if (allowanceBN < bountyData.balanceBN) {
        throw new Error(`Insufficient allowance: Smart Contract (${TICKET_SALE_ADDRESS}) is only approved to spend ${ethers.formatUnits(allowanceBN, bountyData.decimals)} INKY from Bounty Wallet, but needs to spend ${ethers.formatUnits(bountyData.balanceBN, bountyData.decimals)} INKY. Please increase the allowance on the Bounty Wallet.`); 
    }
    
    console.log(`⏳ Executing Bounty transfer via Smart Contract to winner ${winner}...`);
    
    // 1. Envoyer la transaction au SC
    const tx = await contractWithSigner.transferBountyToWinner(winner);
    console.log(`⏳ Bounty transfer transaction sent. Tx hash: ${tx.hash}`);
    
    // 2. Attendre la confirmation
    const receipt = await tx.wait(CONFIRMATIONS); 
    console.log(`✅ Bounty transfer confirmed.`);

    // 3. Récupérer les données de l'événement BountyTransferred
    const bountyTransferredEvent = receipt.logs.find(log => {
        try {
            return contractWithSigner.interface.parseLog(log)?.name === 'BountyTransferred';
        } catch (e) {
            return false;
        }
    });

    if (!bountyTransferredEvent) {
        throw new Error("BountyTransferred event not found in transaction receipt. The SC did not emit the event.");
    }
    
    const parsedLog = contractWithSigner.interface.parseLog(bountyTransferredEvent);
    const { prizeAmount, burnAmount } = parsedLog.args;

    return {
        txHash: tx.hash, 
        prizeAmount: prizeAmount.toString(), 
        burnAmount: burnAmount.toString() 
    };
}

async function startNextRound() {
    const wallet = new ethers.Wallet(PRIVATE_KEY, nexeraProvider);
    const contractWithSigner = new ethers.Contract(TICKET_SALE_ADDRESS, TICKET_SALE_ABI, wallet);
    console.log(`⏳ Starting new round...`);
    const tx = await contractWithSigner.startNewRound();
    console.log(`⏳ Transaction sent. Tx hash: ${tx.hash}`);
    await tx.wait(1);
    console.log(`✅ New round started successfully.`);
    return tx.hash;
}

// Fonction de génération de PDF MISE À JOUR
async function generatePDFReport(data, roundId, contractTxHash = null, newRoundTxHash = null) {
    const staticFileName = `INKY_Tombola_report.pdf`;
    const archiveDir = `archives_rounds_pdf`;
    const archiveFileName = `${archiveDir}/INKY_Tombola_report_${roundId}.pdf`;

    if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
        console.log(`Dossier d'archives créé: ${archiveDir}`);
    }

    // Récupérer le plafond actuel du SC pour le reporting
    const maxBountyAmountINKY = await ticketSaleContract.maxBountyAmountINKY();
    const maxBountyAmount = maxBountyAmountINKY.toString();

    const createAndWritePdf = (filePath) => {
        const doc = new PDFDocument({ margin: 30 });
        doc.pipe(fs.createWriteStream(filePath));

        doc.fontSize(20).text(`INKY Tombola - Round ${roundId} Report`, { align: "center" });
        doc.moveDown();
        doc.fontSize(12).text(`Reference draw date (UTC): ${data.targetDate}`);
        doc.text(`Total tickets: ${data.totalTickets}`);
        doc.text(`Number of participants: ${Object.keys(data.participantsGrouped).length}`);
        doc.moveDown();
        doc.text("Participants and their ticket indexes (grouped):");
        for (const [wallet, indexes] of Object.entries(data.participantsGrouped)) {
            doc.text(`   ${wallet} [${indexes.join(", ")}]`);
        }
        doc.moveDown();
        doc.text("Blockchain block hashes used for the draw:");
        data.ethHashes.forEach((h, i) => doc.text(`   Block #${i + 1} hash: ${h}`));
        doc.moveDown();
        doc.text(`Combined seed (keccak256): ${data.combinedSeed}`);
        doc.text(`Seed as BigInt: ${data.seedBigInt}`);
        doc.text(`Result modulo number of tickets: ${data.seedModulo}`);
        doc.text(`Winner index: ${data.winnerIndex}`);
        doc.text(`Winning wallet: ${data.winner}`);
        
        // Affichage du prix 
        doc.text(`Prize amount transferred to winner (Capped at ${maxBountyAmount} INKY): ${data.prizeAmount} INKY`);

        if (data.burnAmount && parseFloat(data.burnAmount) > 0) {
            doc.text(`Surplus amount burned: ${data.burnAmount} INKY`);
        } else {
            doc.text(`Surplus amount burned: None`);
        }
        if (contractTxHash) doc.text(`Bounty transfer transaction hash (Price & Burn): ${contractTxHash}`); 
        
        if (newRoundTxHash) doc.text(`New round started tx hash: ${newRoundTxHash}`);
        doc.moveDown();
        doc.text("This report is automatically generated to ensure transparency and verifiability.", { italics: true });
        doc.end();
    };
    createAndWritePdf(staticFileName);
    console.log(`📄 PDF generated (static): ${staticFileName}`);
    
    createAndWritePdf(archiveFileName);
    console.log(`📄 PDF generated (archived): ${archiveFileName}`);
}

async function saveWinnerToDB(winnerData) {
    try {
        const sql = `
            INSERT INTO winners (
                roundId, winner, bountyTxHash, prizeAmount, burnAmount, 
                drawDateUTC, totalTickets, numberOfParticipants, newRoundStarted, newRoundTxHash
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const params = [
            parseInt(winnerData.roundId),
            winnerData.winner,
            winnerData.bountyTxHash, 
            winnerData.prizeAmount,
            winnerData.burnAmount, 
            winnerData.drawDateUTC,
            winnerData.totalTickets,
            winnerData.numberOfParticipants,
            winnerData.newRoundStarted ? 1 : 0,
            winnerData.newRoundTxHash
        ];
        await runDB(sql, params);
        console.log(`Winner data saved for Round ${winnerData.roundId}`);
    } catch (err) {
        console.error('Erreur lors de l\'insertion des données', err.message);
        throw err;
    }
}

// ===================== MAIN =====================
async function performDraw() {
    try {
        await setDrawStatus('en_cours');
        console.log("Checking bounty wallet balance...");
        const bountyData = await checkBountyBalance();
        const bountyBalance = bountyData.balanceFormatted;
        if (bountyBalance <= 0) {
            console.log(`⚠️ Bounty wallet is empty. Current balance: ${bountyBalance}. Draw is cancelled for this round.`);
            await setDrawStatus('termine');
            return;
        }
        console.log(`✅ Bounty wallet has a positive balance: ${bountyBalance} INKY. Continuing with draw.`);
        
        const ROUND_ID = await getCurrentRound();
        console.log("Current round:", ROUND_ID);

        // UTILISER getRoundStats() AU LIEU DE getParticipantCount()
        const stats = await getRoundStats(ROUND_ID);
        const numberOfParticipants = stats.totalParticipants;
        console.log(`Number of participants for round ${ROUND_ID}: ${numberOfParticipants}`);
        
        if (numberOfParticipants < MIN_PARTICIPANTS) {
            console.log(`⚠️ Number of participants (${numberOfParticipants}) is below the required threshold of ${MIN_PARTICIPANTS}. Draw is postponed. No new round will be started.`);
            await setDrawStatus('termine');
            return;
        }

        const tickets = await fetchTickets(ROUND_ID);
        if (tickets.length === 0) {
            console.log("No tickets found for this round. Starting a new round and exiting.");
            await startNextRound();
            await setDrawStatus('termine');
            return;
        }

        const now = new Date();
        const targetTimestamp = Math.floor(now.getTime() / 1000);
        const drawDateUTC = now.toISOString().replace("T", " ").replace(".000Z", " UTC");

        const ethHashes = await waitForConfirmedEthBlocks(targetTimestamp, ETH_BLOCKS_N);
        ethHashes.forEach((h, i) => console.log(`Block #${i + 1} hash:`, h));

        const combinedSeed = ethers.keccak256(ethers.concat(ethHashes.map(h => getBytes(h))));
        const seedBigInt = BigInt(combinedSeed);
        const seedModulo = seedBigInt % BigInt(tickets.length);
        const winnerIndex = Number(seedModulo);
        const winner = tickets[winnerIndex];
        console.log("🏆 Winner:", winner);
        
        const participantsGrouped = {};
        tickets.forEach((addr, idx) => {
            if (!participantsGrouped[addr]) participantsGrouped[addr] = [];
            participantsGrouped[addr].push(idx);
        });
        
        // Exécution de la transaction du Smart Contract
        const dataBounty = await executeContractTransfer(winner); 
        const newRoundTxHash = await startNextRound();
        
        // Génération du rapport
        generatePDFReport({
            targetDate: drawDateUTC,
            totalTickets: tickets.length,
            participantsGrouped,
            ethHashes,
            combinedSeed,
            seedBigInt: seedBigInt.toString(),
            seedModulo: seedModulo.toString(),
            winnerIndex,
            winner,
            prizeAmount: dataBounty.prizeAmount, 
            burnAmount: dataBounty.burnAmount 
        }, ROUND_ID, dataBounty.txHash, newRoundTxHash);

        // Sauvegarde en base de données
        const winnerData = {
            roundId: ROUND_ID.toString(),
            winner,
            bountyTxHash: dataBounty.txHash, 
            prizeAmount: dataBounty.prizeAmount,
            burnAmount: dataBounty.burnAmount, 
            drawDateUTC: drawDateUTC,
            totalTickets: tickets.length,
            numberOfParticipants: Object.keys(participantsGrouped).length,
            newRoundStarted: true,
            newRoundTxHash: newRoundTxHash
        };
        await saveWinnerToDB(winnerData);
        console.log(`💾 Données du gagnant exportées vers la base de données.`);
        await setDrawStatus('termine');
    } catch (err) {
        console.error("Error during draw:", err.message);
        await setDrawStatus('erreur');
    }
}

// ===================== SCHEDULER =====================
console.log(`Script de tirage au sort démarré. En attente de l'heure planifiée...`);
cron.schedule(`${SCHEDULE_MINUTE} ${SCHEDULE_HOUR} * * ${SCHEDULE_DAY_OF_WEEK}`, () => {
    console.log(`\n🕒 Heure du tirage : ${SCHEDULE_HOUR}:${SCHEDULE_MINUTE} UTC. Exécution de la tâche...`);
    performDraw();
}, {
    timezone: "Etc/UTC"
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

export { performDraw, getCurrentRound, getRoundStats };