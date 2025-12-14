require('dotenv').config();
const fs = require('fs');
const { IotaClient, getFullnodeUrl } = require('@iota/iota-sdk/client');
const { Ed25519Keypair } = require('@iota/iota-sdk/keypairs/ed25519');
const txModule = require('@iota/iota-sdk/transactions');
const Transaction = txModule.Transaction || txModule.TransactionBlock;
const { decodeIotaPrivateKey } = require('@iota/iota-sdk/cryptography');

// ================= 設定區 =================
const NETWORK = 'testnet';
const DB_FILE = 'hero_db.json';
const PACKAGE_ID = '0xfdb0c3a3cb644df65a4d549be8e870f88e7f2a145c78982d573ee98b8b077487';
const MODULE_HERO = 'hero';
const MODULE_TOKEN = 'heroc_token';

const OBJ_TREASURY = '0xa68b556d3ce2988bdd034ecaffef46154598575c25ab3f2f4a20e08e010742dd';
const OBJ_FIGHT_LIST = '0xbd9a10bb3be28089929beaeff7cea7b65269fd1da6d2c62850a48a7bbdbd4b7c';
const OBJ_RANDOM = '0x8';
const OBJ_CLOCK = '0x6';

const HEROC_COIN_TYPE = `${PACKAGE_ID}::${MODULE_TOKEN}::HEROC_TOKEN`;
const IOTA_TYPE = '0x2::iota::IOTA';

const PRICE_HERO = 50_000_000_000n; 
const GAS_BUDGET = 500_000_000;

// ★★★ V41 效能設定 ★★★
const MAX_CONCURRENT = 500;     
const ROUND_DELAY = 100;       
const SYNC_CONCURRENCY = 50;    

const client = new IotaClient({ url: getFullnodeUrl(NETWORK) });

function getKeypair() {
    const privKey = process.env.SECRET_KEY;
    if (!privKey) throw new Error("缺少 SECRET_KEY");
    if (privKey.startsWith('iotaprivkey') || privKey.startsWith('suiprivkey')) {
        const { secretKey } = decodeIotaPrivateKey(privKey);
        return Ed25519Keypair.fromSecretKey(secretKey);
    } else {
        return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(privKey.replace('0x', ''), 'hex')));
    }
}
const keypair = getKeypair();
const ADDRESS = keypair.toIotaAddress();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 資源管理器 =================
class EquipmentManager {
    constructor(swords, shields) {
        this.swords = swords.map(s => ({ id: s.data.objectId, inUse: false }));
        this.shields = shields.map(s => ({ id: s.data.objectId, inUse: false }));
    }

    borrow() {
        const freeSword = this.swords.find(s => !s.inUse);
        const freeShield = this.shields.find(s => !s.inUse);
        if (freeSword && freeShield) {
            freeSword.inUse = true;
            freeShield.inUse = true;
            return { swordId: freeSword.id, shieldId: freeShield.id };
        }
        return null;
    }

    returnBack(swordId, shieldId) {
        const s = this.swords.find(x => x.id === swordId);
        if (s) s.inUse = false;
        const sh = this.shields.find(x => x.id === shieldId);
        if (sh) sh.inUse = false;
    }
}

// ================= 資料庫邏輯 (V41 非同步寫入優化) =================

// 全域變數控制存檔鎖
let isSaving = false;

// ★ 非同步存檔：不卡住主線程 ★
function saveDBAsync(data) {
    if (isSaving) return; // 如果正在存，這次就跳過
    isSaving = true;
    
    // 將資料轉字串這個動作可能還是稍微耗時，但在 8000 筆時還能接受
    // 這裡使用 writeFile 而不是 writeFileSync
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFile(DB_FILE, jsonStr, 'utf8', (err) => {
        isSaving = false;
        if (err) console.error("⚠️ 背景存檔失敗:", err.message);
        // else console.log("💾 背景存檔完成"); // 太吵可以註解掉
    });
}

async function loadOrFetchDB() {
    if (fs.existsSync(DB_FILE)) {
        console.log(`📂 讀取本地資料庫...`);
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
    return await fullScanAndSave();
}

async function fullScanAndSave() {
    console.log(`🌐 執行二階段極速掃描...`);
    const data = { heroes: [], swords: [], shields: [] };
    
    console.log(`   🔸 掃描 ID...`);
    const heroIds = await fetchAllIds(`${PACKAGE_ID}::${MODULE_HERO}::Hero`);
    
    console.log(`   🔸 下載詳細資料...`);
    data.heroes = await fetchDetailsParallel(heroIds);

    console.log(`   🔸 掃描裝備...`);
    data.swords = await fetchAllObjects(`${PACKAGE_ID}::${MODULE_HERO}::Sword`, false, 500); 
    data.shields = await fetchAllObjects(`${PACKAGE_ID}::${MODULE_HERO}::Shield`, false, 500);
    
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); // 第一次必須同步存
    console.log(`💾 重建完成: ${data.heroes.length} 英雄`);
    return data;
}

async function fetchAllIds(structType) {
    let ids = [];
    let cursor = null;
    let hasNext = true;
    while (hasNext) {
        try {
            const res = await client.getOwnedObjects({
                owner: ADDRESS,
                filter: { StructType: structType },
                options: { showContent: false, showType: true },
                cursor, limit: 50
            });
            if (res.data) ids.push(...res.data.map(o => o.data.objectId));
            cursor = res.nextCursor;
            hasNext = res.hasNextPage;
            if(ids.length % 2000 === 0) process.stdout.write(`\r      ID: ${ids.length}... `);
            if (!cursor) break;
        } catch (e) { await sleep(1000); }
    }
    console.log(`\r      ID 掃描完成: ${ids.length}          `);
    return ids;
}

async function fetchDetailsParallel(allIds) {
    const chunkSize = 50; 
    let requestChunks = [];
    for (let i = 0; i < allIds.length; i += chunkSize) {
        requestChunks.push(allIds.slice(i, i + chunkSize));
    }

    let results = [];
    let processed = 0;
    const total = allIds.length;

    for (let i = 0; i < requestChunks.length; i += SYNC_CONCURRENCY) {
        const currentBatch = requestChunks.slice(i, i + SYNC_CONCURRENCY);
        const promises = currentBatch.map(async (chunkIds) => {
            try {
                return await client.multiGetObjects({ ids: chunkIds, options: { showContent: true, showType: true } });
            } catch (e) { return []; }
        });

        const batchResults = await Promise.all(promises);
        batchResults.forEach(res => {
            if (res && Array.isArray(res)) res.forEach(item => { if (item.data) results.push(item); });
        });

        processed += (currentBatch.length * chunkSize);
        process.stdout.write(`\r      下載: ${Math.min(processed, total)} / ${total}... `);
    }
    console.log("✅");
    return results;
}

async function appendNewHeroes(dbData, newHeroIds) {
    if (!newHeroIds || newHeroIds.length === 0) return;
    console.log(`📥 增量更新 ${newHeroIds.length} 隻...`);
    const newHeroes = await fetchDetailsParallel(newHeroIds);
    dbData.heroes.push(...newHeroes);
    
    // ★ 結構改變時，強制背景存檔
    saveDBAsync(dbData);
    console.log(`💾 英雄總數: ${dbData.heroes.length}`);
}

async function syncAllHeroStates(dbData) {
    if (dbData.heroes.length === 0) return;
    const total = dbData.heroes.length;
    console.log(`🔄 同步狀態 (${total} 隻)...`);

    const allIds = dbData.heroes.map(h => h.data.objectId);
    const updatedHeroes = await fetchDetailsParallel(allIds);

    if (updatedHeroes.length > total * 0.95) {
        dbData.heroes = updatedHeroes;
        // ★ 關鍵優化：這裡不再同步寫入硬碟，改用背景存檔
        // 甚至可以選擇跳過存檔，因為只是攻擊次數變了，記憶體更新就好
        // 為了安全起見，我們每回合 "嘗試" 背景存檔一次
        saveDBAsync(dbData); 
        console.log(` ✅ (背景存檔中)`);
    } else {
        console.log(` ⚠️ 跳過`);
    }
}

async function fetchAllObjects(structType, showContent = false, limitCount = 9999) {
    let items = [];
    let cursor = null;
    do {
        try {
            const res = await client.getOwnedObjects({
                owner: ADDRESS,
                filter: { StructType: structType },
                options: { showContent: showContent, showType: true },
                cursor, limit: 50
            });
            if (res.data) items.push(...res.data);
            cursor = res.nextCursor;
            process.stdout.write(`\r      掃描: ${items.length}... `);
        } catch (e) { 
            process.stdout.write(`\r      ❌ 重試... `);
            await sleep(2000); 
        }
    } while (cursor && items.length < limitCount);
    console.log("✅");
    return items;
}

// ================= Lane =================
class CombatLane {
    constructor(id) {
        this.id = id;
        this.gasCoin = null;
    }

    async sendTx(buildTxCallback) {
        let retry = 3;
        while (retry > 0) {
            try {
                const tx = buildTxCallback();
                tx.setGasPayment([{ objectId: this.gasCoin.coinObjectId, version: this.gasCoin.version, digest: this.gasCoin.digest }]);
                tx.setGasBudget(GAS_BUDGET);
                try {
                    const rgp = await client.getReferenceGasPrice().catch(()=>1000); 
                    if(rgp) tx.setGasPrice(BigInt(rgp));
                } catch(e){}

                let res;
                if (client.signAndExecuteTransaction) {
                    res = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true } });
                } else {
                    res = await client.signAndExecuteTransactionBlock({ signer: keypair, transactionBlock: tx, options: { showEffects: true } });
                }

                if (res.effects && res.effects.gasObject) {
                    this.gasCoin.version = res.effects.gasObject.reference.version;
                    this.gasCoin.digest = res.effects.gasObject.reference.digest;
                }
                return { success: true, digest: res.digest, effects: res.effects };
            } catch (e) {
                const msg = e.message || "";
                if (msg.includes('locked') || msg.includes('reserved') || msg.includes('TooMany') || msg.includes('Mismatch')) {
                    try {
                        const refresh = await client.getObject({ id: this.gasCoin.coinObjectId });
                        if(refresh.data) {
                            this.gasCoin.version = refresh.data.version;
                            this.gasCoin.digest = refresh.data.digest;
                        }
                    } catch(err){}
                    await sleep(1000 + Math.random() * 500);
                    retry--;
                } else {
                    return { success: false, error: msg };
                }
            }
        }
        return { success: false, error: "Retry limit" };
    }
}

// ================= 任務邏輯 =================
async function processHeroTask(lane, hero, equipManager, currentEpoch, stats) {
    const heroId = hero.data.objectId;
    const fields = hero.data.content.fields;

    if (Number(fields.latest_attack_epoch) === currentEpoch && Number(fields.attack_times) >= 3) {
        stats.skipped++;
        return;
    }

    const equipment = equipManager.borrow();
    if (!equipment) return; 

    const isStuck = (fields.sword && fields.sword.fields) || (fields.shield && fields.shield.fields);
    if (isStuck) {
        stats.stuck++;
        await lane.sendTx(() => {
            const tx = new Transaction();
            tx.moveCall({ target: `${PACKAGE_ID}::${MODULE_HERO}::unwrapItems`, arguments: [tx.object(heroId)] });
            return tx;
        });
    }

    const res = await lane.sendTx(() => {
        const tx = new Transaction();
        tx.moveCall({ target: `${PACKAGE_ID}::${MODULE_HERO}::equip_sword`, arguments: [tx.object(heroId), tx.object(equipment.swordId)] });
        tx.moveCall({ target: `${PACKAGE_ID}::${MODULE_HERO}::equip_shield`, arguments: [tx.object(heroId), tx.object(equipment.shieldId)] });
        tx.moveCall({ 
            target: `${PACKAGE_ID}::${MODULE_HERO}::attack_the_boss`, 
            arguments: [tx.object(OBJ_CLOCK), tx.object(OBJ_RANDOM), tx.object(OBJ_TREASURY), tx.object(heroId), tx.object(OBJ_FIGHT_LIST)] 
        });
        return tx;
    });

    await lane.sendTx(() => {
        const tx = new Transaction();
        tx.moveCall({ target: `${PACKAGE_ID}::${MODULE_HERO}::unwrapItems`, arguments: [tx.object(heroId)] });
        return tx;
    });

    equipManager.returnBack(equipment.swordId, equipment.shieldId);

    if (res.success) {
        process.stdout.write(`.`); 
        stats.attacked++;
    }
}

// ★★★ V41 優化：智慧查帳 (只翻錢包直到夠用為止) ★★★
async function mergeAllCoins(adminLane) {
    try {
        let allCoins = [];
        let cursor = null;
        let totalBalance = 0n;
        let page = 0;

        do {
            const res = await client.getCoins({ owner: ADDRESS, coinType: HEROC_COIN_TYPE, cursor, limit: 50 });
            allCoins.push(...res.data);
            
            // 計算目前找到的總額
            res.data.forEach(c => totalBalance += BigInt(c.balance));

            cursor = res.nextCursor;
            page++;

            // ★ 關鍵優化：如果我們已經找到足夠多的錢 (例如 > 200 BB) 和足夠多的 Coin 物件 (>5)，就不用再翻了
            // 這樣可以避免翻完整個 8000+ 物件的錢包
            if (totalBalance > PRICE_HERO * 10n && allCoins.length > 5) {
                break; 
            }

        } while (cursor && page < 5); // 最多只翻 5 頁，防止卡死

        if (allCoins.length === 0) return { total: 0n, primary: null };

        allCoins.sort((a, b) => Number(b.balance) - Number(a.balance));
        const primary = allCoins[0];

        // 只有當有多個小幣時才合併
        if (allCoins.length > 5 && adminLane) {
            const coinsToMerge = allCoins.slice(1, 50).map(c => c.coinObjectId);
            await adminLane.sendTx(() => {
                const tx = new Transaction();
                tx.mergeCoins(tx.object(primary.coinObjectId), coinsToMerge.map(id => tx.object(id)));
                return tx;
            });
        }
        return { total: totalBalance, primary: primary };
    } catch (e) { return { total: 0n, primary: null }; }
}

async function bulkSummon_AllIn(lanes, paymentCoin, totalBalance) {
    const maxAffordable = Number(totalBalance / PRICE_HERO);
    if (maxAffordable < 1) return { success: false, newIds: [] };

    console.log(`\n🎉 梭哈召喚: ${maxAffordable} 隻`);
    
    const SPLIT_BATCH = 25; 
    let remaining = maxAffordable;
    let allNewHeroIds = [];
    let round = 1;

    while (remaining > 0) {
        let currentBatchCount = Math.min(remaining, SPLIT_BATCH);
        console.log(`\n🔹 Round ${round}: 召喚 ${currentBatchCount} 隻...`);
        
        let ammoToUse = [];
        let safeLane = lanes.find(l => l.gasCoin.coinObjectId !== paymentCoin.coinObjectId) || lanes[0];

        try {
            process.stdout.write(`   🔨 切分... `);
            const splitTxRes = await safeLane.sendTx(() => {
                const tx = new Transaction();
                tx.setGasBudget(800_000_000); 
                for (let k = 0; k < currentBatchCount; k++) {
                    const newCoin = tx.moveCall({
                        target: '0x2::coin::split',
                        typeArguments: [HEROC_COIN_TYPE],
                        arguments: [tx.object(paymentCoin.coinObjectId), tx.pure.u64(PRICE_HERO)]
                    });
                    tx.transferObjects([newCoin], tx.pure.address(ADDRESS));
                }
                return tx;
            });

            if (!splitTxRes.success) {
                console.log(`❌ 失敗`);
                break; 
            }

            if (splitTxRes.effects && splitTxRes.effects.created) {
                ammoToUse = splitTxRes.effects.created.map(c => c.reference.objectId);
                console.log(`✅ 成功 (${ammoToUse.length} 枚)`);
            } else {
                console.log(`❌ 無物件`);
                break;
            }

            process.stdout.write(`   ⏳ 等待生效... `);
            await sleep(3000); 

        } catch (e) {
            console.log(`❌ 異常: ${e.message}`);
            break;
        }

        if (ammoToUse.length > 0) {
            console.log(`   🚀 發射！`);
            const LANE_COUNT = lanes.length;
            const summonTasks = ammoToUse.map((coinId, index) => {
                const lane = lanes[index % LANE_COUNT]; 
                return lane.sendTx(() => {
                    const tx = new Transaction();
                    tx.moveCall({
                        target: `${PACKAGE_ID}::${MODULE_HERO}::create_hero`,
                        arguments: [tx.object(OBJ_RANDOM), tx.object(OBJ_TREASURY), tx.object(coinId)]
                    });
                    return tx;
                }).then(res => {
                    if(res.success && res.effects && res.effects.created) {
                        res.effects.created.forEach(c => allNewHeroIds.push(c.reference.objectId));
                        process.stdout.write("⚡");
                        return true;
                    } 
                    process.stdout.write("x");
                    return false;
                });
            });
            await Promise.all(summonTasks);
        }

        remaining -= currentBatchCount;
        round++;
        if (remaining > 0) await sleep(1000);
    }

    console.log(`\n🏁 梭哈結束，+${allNewHeroIds.length} 新英雄`);
    return { success: allNewHeroIds.length > 0, newIds: allNewHeroIds };
}

async function runBot() {
    console.log(`🚀 平行運算機器人 V41 (極速優化: 非同步存檔 + 智慧查帳)`);
    
    let dbData = await loadOrFetchDB();
    if (dbData.swords.length === 0) throw new Error("沒裝備！");

    const equipManager = new EquipmentManager(dbData.swords, dbData.shields);
    console.log(`⚔️  裝備庫：${dbData.swords.length} 套`);

    const lanes = Array.from({ length: MAX_CONCURRENT }, (_, i) => new CombatLane(i));
    process.stdout.write("   分配 Gas... ");
    let gasCoins = [];
    let cursor = null;
    do {
        const res = await client.getCoins({ owner: ADDRESS, coinType: IOTA_TYPE, cursor, limit: 50 });
        gasCoins.push(...res.data);
        cursor = res.nextCursor;
        if (gasCoins.length >= MAX_CONCURRENT + 10) break; 
    } while (cursor);
    const validGas = gasCoins.filter(c => BigInt(c.balance) > 20_000_000n).sort((a,b) => Number(b.balance) - Number(a.balance));
    
    if(validGas.length < MAX_CONCURRENT) {
        console.warn(`⚠️  Gas 不足，降級併發。`);
        lanes.splice(validGas.length); 
    }
    
    for(let i=0; i<lanes.length; i++) lanes[i].gasCoin = validGas[i];
    console.log(`✅ 啟用 ${lanes.length} 條通道`);

    while (true) {
        console.log('\n--- 🔄 新回合 ---');
        
        await syncAllHeroStates(dbData);
        
        // V41: 這裡只會快速掃描幾頁，不會卡住
        const { total: balance, primary: primaryCoin } = await mergeAllCoins(lanes[0]);
        console.log(`💰 資金: ${balance / 1_000_000_000n} BB`);

        const currentEpoch = Number((await client.getLatestIotaSystemState()).epoch);
        const jobQueue = [...dbData.heroes].sort(() => 0.5 - Math.random());
        console.log(`🔥 任務隊列：${jobQueue.length} 隻 | Epoch: ${currentEpoch}`);

        let heroIndex = 0;
        let stats = { attacked: 0, skipped: 0, stuck: 0 }; 

        const worker = async (lane) => {
            while (heroIndex < jobQueue.length) {
                const currentIndex = heroIndex++;
                if (currentIndex >= jobQueue.length) break;
                await processHeroTask(lane, jobQueue[currentIndex], equipManager, currentEpoch, stats);
            }
        };
        await Promise.all(lanes.map(lane => worker(lane)));

        console.log(`\n📊 結算: 攻${stats.attacked} / 跳${stats.skipped} / 卡${stats.stuck}`);

        const allDone = stats.skipped === dbData.heroes.length && stats.attacked === 0;
        
        if (allDone) {
            console.log("💤 全員休息。");
            if (balance >= PRICE_HERO && primaryCoin) {
                const result = await bulkSummon_AllIn(lanes, primaryCoin, balance);
                if (result.success && result.newIds.length > 0) {
                    await appendNewHeroes(dbData, result.newIds);
                    continue; 
                }
            } else {
                console.log("💸 資金耗盡，等待明日...");
                await sleep(30000); 
            }
        } else {
            await sleep(ROUND_DELAY);
        }
    }
}

runBot();
