import { LootSheetNPC5eHelper } from './LootSheetNPC5eHelper.js';
import { MODULE } from '../config.js';
import { PermissionHelper } from './PermissionHelper.js';
class ItemHelper {
    /**
    * Take an options object an either keep values or set the default
    *
    * @param {object} options
    * @returns {object}
    *
    */
    static _getOptionsDefault(options = {}) {
        return {
            chanceOfDamagedItems: options?.chanceOfDamagedItems | 0,
            damagedItemsMultiplier: options?.damagedItemsMultiplier | 0,
            removeDamagedItems: options?.removeDamagedItems | false
        };
    }
    /**
     *
     * @param {Actor5e} source
     * @param {Actor5e} destination
     * @param {Array<Item>} items
     */
    static async lootItems(source, destination, items, sourceToken) {
        let movedItems = await ItemHelper.moveItems(source.actor, destination, items);

        ItemHelper.chatMessage(source, destination, movedItems, { type: 'loot' })
    }

    /**
     *
     * @param {Actor5e} source
     * @param {Actor5e} destination
     * @param {Item} items
     * @returns {Array<object>} Array with moved item
     */
    static async moveItems(source, destination, items) {
        const sourceUpdates = [],
            sourceDeletes = [],
            destinationAdditions = [],
            destinationUpdates = [],
            results = [];

        /**
         *  Could be optimized to do a direct call instead of {crudAction}embeddedDocuments
         *  when items is only one item.
         **/
        for (let item of items) {
            const sourceItem = source.getEmbeddedDocument("Item", item.id),
                quantity = (sourceItem.data.data.quantity < item.data.data.quantity) ? parseInt(sourceItem.data.data.quantity) : parseInt(item.data.data.quantity),
                updatedItem = { _id: sourceItem.id, data: { quantity: sourceItem.data.data.quantity - quantity } },
                targetItem = destination.getEmbeddedCollection('Item').find(i =>
                    sourceItem.name === i.name
                    && sourceItem.data.data.price === i.data.data.price
                    && sourceItem.data.data.weight === i.data.data.weight
                );

            let newItem = {};

            if (targetItem) {
                let targetUpdate = { _id: targetItem.id, data: { quantity: parseInt(targetItem.data.data.quantity + quantity) } };
                destinationUpdates.push(targetUpdate);
            } else {
                newItem = duplicate(sourceItem);
                newItem.data.quantity = parseInt(quantity);
                destinationAdditions.push(newItem);
            }

            if (updatedItem.data.quantity === 0) {
                sourceDeletes.push(sourceItem.id);
            } else {
                sourceUpdates.push(updatedItem);
            }

            results.push({
                item: targetItem || newItem,
                quantity: quantity
            });
        }

        await ItemHelper._updateActorInventory(source, { type: 'delete', data: sourceDeletes }, sourceUpdates);
        await ItemHelper._updateActorInventory(destination, { type: 'create', data: destinationAdditions }, destinationUpdates);

        return results;
    }

    /**
     * @param {Array<object>} items
     * @param {number} chanceOfDamagedItems
     * @param {number} damagedItemsMultiplier
     *
     * @returns {Array<Items>} items Filtered lootable items
     */
    static getLootableItems(
        items,
        options = {}
    ) {
        options = ItemHelper._getOptionsDefault(options);

        return items
            /** .map((item) => {
                return item.toObject();
            })*/
            .filter((item) => {
                if (item.type == 'weapon') {
                    return item.data.weaponType != 'natural';
                }

                if (item.type == 'equipment') {
                    if (!item.data.armor) return true;
                    return item.data.armor.type != 'natural';
                }

                return !['class', 'spell', 'feat'].includes(item.type);
            })
            .filter((item) => {
                if (LootSheetNPC5eHelper._isItemDamaged(item, options.chanceOfDamagedItems)) {
                    if (options.removeDamagedItems) return false;

                    item.name += ' (Damaged)';
                    item.data.price *= options.damagedItemsMultiplier;
                }

                return true;
            })
            .map((item) => {
                item.data.equipped = false;
                return item;
            });
    }

    /**
     * Updates an item in an actor's inventory
     *
     * @param {Actor5e} actor
     * @param {object} items
     * @param {Array<Item5e>} updatedItems
     */
    static async _updateActorInventory(actor, items, updatedItems) {

        if (items.data.length > 0) {
            if (items.type === 'create') {
                await actor.createEmbeddedDocuments("Item", items.data);
            } else if (items.type === 'delete') {
                await actor.deleteEmbeddedDocuments("Item", items.data);
            }
        }

        if (updatedItems.length > 0) {
            await actor.updateEmbeddedDocuments("Item", updatedItems);
        }
    }

    /**
     * Handle a buy transaction between seller & buyer
     *
     * @param {Actor} seller
     * @param {Actor} buyer
     * @param {string} id
     * @param {number} quantity
     */
    static async transaction(seller, buyer, id, quantity) {
        // On 0 quantity skip everything to avoid error down the line
        if (quantity == 0) return ItemHelper.errorMessageToActor(buyer, `Not enought items on vendor.`);

        const soldItem = seller.getEmbeddedDocument("Item", id);

        quantity = (soldItem.data.data.quantity < quantity) ? parseInt(soldItem.data.data.quantity) : parseInt(quantity);

        let priceModifier = parseInt(seller.getFlag(MODULE.ns, MODULE.keys.priceModifier)),
            itemCostInGold = (Math.round(soldItem.data.data.price * priceModifier * 100) / 100) * quantity,
            successfullTransaction = await ItemHelper.updateFunds(seller, buyer, itemCostInGold);

        if (successfullTransaction) {
            let moved = await ItemHelper.moveItems(seller, buyer, [{ id: id, data: { data: { quantity: quantity } } }]);
            ItemHelper.chatMessage(seller, buyer, moved, { type: 'buy' });
        }
    }

    /**
     *
     * @param {Actor5e} seller
     * @param {Actor5e} buyer
     * @param {number} itemCostInGold
     *
     * @returns {boolean}
     */
    static async updateFunds(seller, buyer, itemCostInGold) {
        //console.log(`ItemCost: ${itemCostInGold}`)
        let buyerFunds = duplicate(LootSheetNPC5eHelper.convertCurrencyFromObject(buyer.data.data.currency)),
            sellerFunds = duplicate(LootSheetNPC5eHelper.convertCurrencyFromObject(seller.data.data.currency));

        const compensationCurrency = { "pp": "gp", "gp": "ep", "ep": "sp", "sp": "cp" },
            convertCurrency = game.settings.get(MODULE.ns, "convertCurrency"),
            rates = {
                "pp": 1,
                "gp": CONFIG.DND5E.currencies.gp.conversion.each,
                "ep": CONFIG.DND5E.currencies.ep.conversion.each,
                "sp": CONFIG.DND5E.currencies.sp.conversion.each,
                "cp": CONFIG.DND5E.currencies.cp.conversion.each
            },
            itemCostInPlatinum = itemCostInGold / rates["gp"];

        let buyerFundsAsPlatinum = buyerFunds["pp"];

        buyerFundsAsPlatinum += buyerFunds["gp"] / rates["gp"];
        buyerFundsAsPlatinum += buyerFunds["ep"] / rates["gp"] / rates["ep"];
        buyerFundsAsPlatinum += buyerFunds["sp"] / rates["gp"] / rates["ep"] / rates["sp"];
        buyerFundsAsPlatinum += buyerFunds["cp"] / rates["gp"] / rates["ep"] / rates["sp"] / rates["cp"];

        // console.log(`buyerFundsAsPlatinum : ${buyerFundsAsPlatinum}`);

        if (itemCostInPlatinum > buyerFundsAsPlatinum) {
            ItemHelper.errorMessageToActor(buyer, buyer.name + ` doesn't have enough funds to purchase an item for ${itemCostInGold}gp.`);
            return false;
        }

        if (convertCurrency) {
            buyerFundsAsPlatinum -= itemCostInPlatinum;

            for (let currency in buyerFunds) {
                buyerFunds[currency] = 0; // Remove every coin we have
            }
            buyerFunds["pp"] = buyerFundsAsPlatinum

        } else {
            // We just pay in partial platinum.
            buyerFunds["pp"] -= itemCostInPlatinum
            // Now we exchange all negative funds with coins of lower value

            for (let currency in buyerFunds) {
                let amount = buyerFunds[currency]
                // console.log(`${currency} : ${amount}`);
                if (amount >= 0) continue;

                // If we have ever so slightly negative cp, it is likely due to floating point error
                // We dont care and just give it to the player
                if (currency == "cp") {
                    buyerFunds["cp"] = 0;
                    continue;
                }

                let compCurrency = compensationCurrency[currency]

                buyerFunds[currency] = 0;
                buyerFunds[compCurrency] += amount * rates[compCurrency]; // amount is a negative value so we add it
                // console.log(`Substracted: ${amount * conversionRates[compCurrency]} ${compCurrency}`);
            }
        }

        // console.log(`Smoothing out`);
        // Finally we exchange partial coins with as little change as possible
        for (let currency in buyerFunds) {
            let amount = buyerFunds[currency]

            //console.log(`${currency} : ${amount}: ${conversionRates[currency]}`);

            // We round to 5 decimals. 1 pp is 1000cp, so 5 decimals always rounds good enough
            // We need to round because otherwise we get 15.99999999999918 instead of 16 due to floating point precision
            // If we would floor 15.99999999999918 everything explodes
            let newFund = Math.floor(Math.round(amount * 1e5) / 1e5);
            buyerFunds[currency] = newFund;

            //console.log(`New Buyer funds ${currency}: ${buyerFunds[currency]}`);
            let compCurrency = compensationCurrency[currency]

            if (currency != "cp") {
                // We calculate the amount of lower currency we get for the fraction of higher currency we have
                let toAdd = Math.round((amount - newFund) * 1e5) / 1e5 * rates[compCurrency]
                buyerFunds[compCurrency] += toAdd
                //console.log(`Added ${toAdd} to ${compCurrency} it is now ${buyerFunds[compCurrency]}`);
            }
        }

        sellerFunds.gp += itemCostInGold;

        await seller.update({ data: { currency: sellerFunds } });
        await buyer.update({ data: { currency: buyerFunds } });

        return true;
    }

    static FormatPrice(price, system = 'dnd5e') {
        if (system == 'dnd5e') {
            let nprice = price * 100
            let cp = Math.floor(((nprice % 100) % 10));
            let sp = Math.floor((nprice % 100) / 10);
            let gp = Math.floor(price)
            return { cp: cp, sp: sp, gp: gp, ep: 0, pp: 0 }
        }
    }

    /**
     *
     * @param {Actor5e} source
     * @param {User} destination
     */
    static async lootCoins(source, destination) {
        const actorData = source.data;

        let sheetCurrency = LootSheetNPC5eHelper.convertCurrencyFromObject(actorData.data.currency);
        //console.log("Loot Sheet | Currency data", currency);

        let msg = [];
        let currency = LootSheetNPC5eHelper.convertCurrencyFromObject(destination.data.data.currency),
            newCurrency = duplicate(LootSheetNPC5eHelper.convertCurrencyFromObject(destination.data.data.currency));

        //console.log("Loot Sheet | Current Currency", currency);

        for (let c in currency) {
            // add msg for chat description
            if (sheetCurrency[c]) {
                //console.log("Loot Sheet | New currency for " + c, currencySplit[c]);
                msg.push(` ${sheetCurrency[c]} ${c} coins`)
            }
            if (sheetCurrency[c] != null) {
                // Add currency to permitted actor
                newCurrency[c] = parseInt(currency[c] || 0) + parseInt(sheetCurrency[c]);
                destination.update({
                    'data.currency': newCurrency
                });
            }
        }

        // Remove currency from loot actor.
        let lootCurrency = LootSheetNPC5eHelper.convertCurrencyFromObject(source.data.data.currency),
            zeroCurrency = {};

        for (let c in lootCurrency) {
            zeroCurrency[c] = {
                'type': sheetCurrency[c].type,
                'label': sheetCurrency[c].type,
                'value': 0
            }
            source.update({
                "data.currency": zeroCurrency
            });
        }

        // Create chat message for coins received
        if (msg.length != 0) {
            let message = `${destination.data.name} receives: `;
            message += msg.join(",");
            ChatMessage.create({
                user: game.user._id,
                speaker: {
                    actor: source,
                    alias: source.name
                },
                content: message,
                flags: {
                    lootsheetnpc5e: {
                        type: 'loot',
                        lootedCurrency: lootCurrency
                    }
                }
            });
        }
    }

    /**
     * Split the currency of an actor between multiple actors
     *
     * @param {Actor5e} actor
     * @returns
     */
    static distributeCoins(actor) {
        const actorData = actor.data,
            players = game.users.players,
            observers = ItemHelper.getEligablePlayers(players, actor, observers),
            [currencyShares, npcRemainingCurrency] = ItemHelper.getSharesAndRemainder(actorData.data.currency, observers.length);

        let msg = [];

        console.log(MODULE.ns + " | ItemHelper | splitCoins | actorData", actorData);
        console.log(MODULE.ns + " | ItemHelper | splitCoins | players", players);
        console.log(MODULE.ns + " | ItemHelper | splitCoins | observers", observers);
        console.log(MODULE.ns + " | ItemHelper | splitCoins | currencyShares", currencyShares);
        console.log(MODULE.ns + " | ItemHelper | splitCoins | npcRemainingCurrency", npcRemainingCurrency);

        if (observers.length === 0) return;

        // add currency to actors existing coins
        debugger;

        for (let u of observers) {
            //console.log("Loot Sheet | u of observers", u);
            if (u === null) continue;

            msg = [];
            let currency = LootSheetNPC5eHelper.convertCurrencyFromObject(u.data.data.currency),
                newCurrency = duplicate(LootSheetNPC5eHelper.convertCurrencyFromObject(u.data.data.currency));

            //console.log("Loot Sheet | Current Currency", currency);

            for (let c in currency) {
                // add msg for chat description
                if (currencySplit[c]) {
                    //console.log("Loot Sheet | New currency for " + c, currencySplit[c]);
                    msg.push(` ${currencySplit[c]} ${c} coins`)
                }

                // Add currency to permitted actor
                newCurrency[c] = parseInt(currency[c] || 0) + currencySplit[c];

                //console.log("Loot Sheet | New Currency", newCurrency);
                u.update({
                    'data.currency': newCurrency
                });
            }
        }

        actor.update({
            "data.currency": currencyRemainder
        });


        // Create chat message for coins received
        if (msg.length != 0) {
            let message = `${u.data.name} receives: `;
            message += msg.join(",");
        }

        ChatMessage.create({
            user: game.user.id,
            speaker: {
                actor: actor,
                alias: actor.name
            },
            content: message
        });
    }

    /**
     * Get all players with at least observer permissions
     *
     * @param {Actor5e} actor
     * @param {Array<User>} players
     *
     * @returns {Array<User>}
     */
    static getEligablePlayers(actor, players) {
        let observers = [];
        for (let player of players) {
            if (
                player != "default"
                && PermissionHelper.getLootPermissionForPlayer(actor.data, player) >= 2
            ) {
                let eligablePlayerCharacter = game.actors.get(player.data.character);
                if (eligablePlayerCharacter != null && (player.data.role === 1 || player.data.role === 2))
                    observers.push(eligablePlayerCharacter);
            }
        }
        return observers;
    }

    /**
     * Splits the values of a type in the stack between splitBy
     *
     * @param {object} stack
     * @param {number} splitBy
     *
     * @returns {Array<object>} Array with
     */
    static getSharesAndRemainder(stack, splitBy) {
        let shares = [],
            remainder = {};

        for (let type in stack) {
            shares[type] = Math.floor(stack[type] / splitBy);
            remainder[type] = shares[type] % splitBy;
        }

        return [shares, remainder];
    }

    /**
     *
     * @param {Token} source
     * @param {Actor5e} destination
     * @param {string} message
     * @param {Item5e} item
     */
    static async chatMessage(source, destination, movedItems, options = { type: 'loot' }) {
        if (game.settings.get(MODULE.ns, "buyChat")) {
            const existingMessage = ItemHelper.getItemsFromLootMessage(destination.id, source.id);
            let existingItems = existingMessage?.items;

            // cleanup lootedItems
            /**
             * @type {Array<Item5e>}
             *
             */
            movedItems = movedItems.map(el => ({
                quantity: el.quantity,
                priceTotal: Math.floor(el.item.data.data.price * el.quantity),
                data: {
                    documentName: el.item.documentName,
                    img: el.item.img,
                    name: el.item.name,
                    id: el.item._id,
                    price: Math.floor(el.item.data.data.price),
                    rarity: el.item.data.data.rarity || 'common'
                }
            }));

            if (existingItems) {
                for (let entry of movedItems) {
                    const itemInMessage = existingItems.find(item => item.data.id === entry.data.id);
                    if (itemInMessage) {
                        itemInMessage.quantity += entry.quantity;
                    } else {
                        existingItems.push(entry);
                    }
                }
            }

            const message = await renderTemplate(MODULE.templatePath + '/chat/loot-chat-card.hbs', {
                templatePath: MODULE.templatePath,
                colorRarity: game.settings.get(MODULE.ns, "colorRarity"),
                source: source,
                destination: destination,
                items: existingItems || movedItems,
                type: options.type
            });

            if (existingItems) {
                ChatMessage.updateDocuments([{
                    _id: existingMessage.id,
                    content: message,
                    flags: {
                        lootsheetnpc5e: {
                            loot: existingItems
                        }
                    }
                }]);
            } else {
                ChatMessage.create({
                    user: game.user.id,
                    speaker: {
                        actor: destination,
                        alias: destination.name
                    },
                    content: message,
                    flags: {
                        lootsheetnpc5e: {
                            lootId: destination.id + '-' + source.id,
                            loot: movedItems
                        }
                    }
                });
            }
        }
    }

    /**
     * Check for messaged where a flag of `looterId-lootedId`
     * parse the html and extract the items.
     *
     * @param {*} looterId
     * @param {*} lootedId
     */
    static getItemsFromLootMessage(looterId, lootedId) {
        //get messages by lootId
        let existingLootMessage = game.messages.find(m => m.data.flags.lootsheetnpc5e.lootId == looterId + '-' + lootedId)

        if (existingLootMessage) {
            return { id: existingLootMessage.id, items: existingLootMessage.getFlag(MODULE.ns, 'loot') };
        }

        return [];
    }

    /**
     *
     * @param {Actor5e} target
     * @param {string} message
     */
    static errorMessageToActor(target, message) {
        game.socket.emit(MODULE.socket, {
            type: "error",
            targetId: target.id,
            message: message
        });
    }
}
export { ItemHelper };
