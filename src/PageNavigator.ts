import { SendHandler, EmbedResolveable, UserResolvable } from "./types";
import { DynaSendOptions } from "./dynaSend";

export type PaginationEvent =
    | "pageChanged"
    | "pageBack"
    | "pageNext"
    | "pageJumped"
    | "selectMenuOptionPicked"
    | "collect"
    | "react"
    | "timeout";
export type PaginationType = "short" | "shortJump" | "long" | "longJump";
export type PageResolveable = EmbedResolveable | EmbedResolveable[] | PageData | NestedPageData;

export interface PageNavigatorOptions {
    /** The type of pagination. Defaults to `short`. */
    type?: PaginationType;
    /** The user or users that are allowed to interact with the navigator. */
    allowedParticipants?: UserResolvable[];
    /** The pages to be displayed. */
    pages: PageResolveable | PageResolveable[];
    /** Whether or not to use reactions instead of buttons. */
    useReactions?: boolean;
    /** Whether to only add the `Page Jump` action when needed.
     *
     * I.E. if there's more than 5 pages, add the `Page Jump` button/reaction.
     *
     * ___NOTE:___ The threshold can be configured in the `./this.options.config.json` file. */
    dynamic?: boolean;
    /** How long to wait before timing out. Use `undefined` to never timeout.
     *
     * Defaults to `timeouts.PAGINATION`. Configure in `./this.options.config.json`.
     *
     * This option also utilizes {@link jsTools.parseTime}, letting you use "10s" or "1m 30s" instead of a number. */
    timeout?: number | string | undefined;
    /** A custom DJS config. */
    config?: DJSConfig;
    /** What to do after the page navigator times out.
     *
     * ___1.___ `disableComponents`: Disable the components. (default: `false`)
     *
     * ___2.___ `clearComponents`: Clear the components. (default: `true`)
     *
     * ___3.___ `clearReactions`: Clear the reactions. (default: `true`)
     *
     * ___4.___ `deleteMessage`: Delete the message. (default: `false`) */
    postTimeout?: {
        disableComponents?: boolean;
        clearComponentsOrReactions?: boolean;
        deleteMessage?: boolean;
    };
}

export interface PageData {
    content?: string;
    embed: EmbedResolveable;
}

export interface NestedPageData {
    nestedContent?: string[];
    nestedEmbeds: EmbedResolveable[];
}

export interface SelectMenuOptionData {
    /** The emoji to be displayed to the left of the option. */
    emoji?: string | null;
    /** The main text to be displayed. */
    label: string;
    /** The description to be displayed. */
    description?: string;
    /** Custom option ID. Useful if you have custom handling for this option. */
    value?: string;
    /** Whether this is the default option. */
    default?: boolean;
}

export interface SendOptions extends Omit<DynaSendOptions, "content" | "embeds" | "components"> {}

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    CacheType,
    ComponentEmojiResolvable,
    GuildMember,
    InteractionCollector,
    Message,
    MessageReaction,
    ReactionCollector,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    StringSelectMenuOptionBuilder,
    User
} from "discord.js";
import { clamp, forceArray, getProp, parseTime } from "jstools";
import { DJSConfig, djsConfig } from "./config";
import { dynaSend } from "./dynaSend";

function isPageData(pageData: any): pageData is PageData {
    return Object.hasOwn(pageData, "embed");
}

function isNestedPageData(pageData: any): pageData is NestedPageData {
    return Object.hasOwn(pageData, "nestedEmbeds");
}

export class PageNavigator {
    options: {
        type: PaginationType;
        allowedParticipants: UserResolvable[];
        pages: Array<PageData | NestedPageData>;
        useReactions: boolean;
        dynamic: boolean;
        timeout: number | null;
        config: DJSConfig;
        postTimeout: {
            disableComponents: boolean;
            clearComponentsOrReactions: boolean;
            deleteMessage: boolean;
        };
    };

    data: {
        paginationReactionNames: string[];

        message: Message | null;
        messageActionRows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
        extraUserButtons: { index: number; component: ButtonBuilder }[];

        page: {
            currentEmbed: EmbedResolveable | null;
            currentData: PageData | NestedPageData | null;
            currentMessageContent: string | undefined;
            index: { current: number; nested: number };
        };

        selectMenu: {
            currentlySelected: StringSelectMenuOptionBuilder | null;
            optionIds: string[];
        };

        navigation: {
            reactions: { name: string; id: string }[];
            required: boolean;
            canUseLong: boolean;
            canJump: boolean;
        };

        collectors: {
            component: InteractionCollector<StringSelectMenuInteraction | ButtonInteraction> | null;
            reaction: ReactionCollector | null;
        };

        components: {
            actionRows: {
                selectMenu: ActionRowBuilder<StringSelectMenuBuilder>;
                navigation: ActionRowBuilder<ButtonBuilder>;
            };

            selectMenu: StringSelectMenuBuilder;
            navigation: {
                to_first: ButtonBuilder;
                back: ButtonBuilder;
                jump: ButtonBuilder;
                next: ButtonBuilder;
                to_last: ButtonBuilder;
            };
        };
    };

    private events: {
        pageChanged: Array<{ listener: Function; once: boolean }>;
        pageBack: Array<{ listener: Function; once: boolean }>;
        pageNext: Array<{ listener: Function; once: boolean }>;
        pageJumped: Array<{ listener: Function; once: boolean }>;
        selectMenuOptionPicked: Array<{ listener: Function; once: boolean }>;
        collect: Array<{ listener: Function; once: boolean }>;
        react: Array<{ listener: Function; once: boolean }>;
        timeout: Array<{ listener: Function; once: boolean }>;
    };

    private resolveEmbedsToPages(
        embeds: PageResolveable | PageResolveable[] | PageResolveable[][]
    ): Array<PageData | NestedPageData> {
        const _pages = forceArray(embeds);
        const resolvedPages: Array<PageData | NestedPageData> = [];

        for (let p of _pages) {
            // No change
            if (isPageData(p) || isNestedPageData(p)) {
                resolvedPages.push(p);
            }
            // Nested array
            else if (Array.isArray(p)) {
                resolvedPages.push({ nestedEmbeds: p as EmbedResolveable[] });
            }
            // Single array
            else {
                resolvedPages.push({ embed: p as EmbedResolveable });
            }
        }

        return resolvedPages;
    }

    private createButton(data: { custom_id: string; emoji?: ComponentEmojiResolvable; label: string }): ButtonBuilder {
        let button = new ButtonBuilder({ custom_id: data.custom_id, style: ButtonStyle.Secondary });
        if (data.label) button.setLabel(data.label);
        else if (data.emoji) button.setEmoji(data.emoji);
        // prettier-ignore
        else throw new Error(
			"[PageNavigator>createButton] You must provide text or an emoji ID for this navigator button in '_dT_this.options.config.json'."
        )
        return button;
    }

    private setPage(
        pageIndex: number = this.data.page.index.current,
        nestedPageIndex: number = this.data.page.index.nested
    ): void {
        // Clamp page index to the number of pages
        this.data.page.index.current = clamp(pageIndex, this.options.pages.length - 1);

        // Set the currently selected option, if it exists
        this.data.selectMenu.currentlySelected =
            this.data.components.selectMenu.options[this.data.page.index.current] || null;

        if (this.data.selectMenu.currentlySelected) {
            // Reset the 'default' property for each select menu option
            this.data.components.selectMenu.options.forEach(o => o.setDefault(false));
            // Set the 'default' property for the currently selected option
            this.data.selectMenu.currentlySelected.setDefault(true);
        }

        /* - - - - - { Set the Current Page } - - - - - */
        let pageData = this.options.pages[this.data.page.index.current];

        if (isNestedPageData(pageData)) {
            /// Clamp nested page index to the number of nested pages & allow overflow wrapping
            this.data.page.index.nested = nestedPageIndex % pageData.nestedEmbeds.length;
            if (this.data.page.index.nested < 0) this.data.page.index.nested = pageData.nestedEmbeds.length - 1;

            this.data.page.currentEmbed = pageData.nestedEmbeds[this.data.page.index.nested];
            this.data.page.currentData = pageData;
            this.data.page.currentMessageContent = pageData.nestedContent
                ? pageData.nestedContent[this.data.page.index.nested] || undefined
                : undefined;
        } else {
            // Reset nested page index
            this.data.page.index.nested = 0;

            this.data.page.currentEmbed = pageData.embed;
            this.data.page.currentData = pageData;
            this.data.page.currentMessageContent = pageData.content || undefined;
        }

        /* - - - - - { Determine Navigation Options } - - - - - */
        const { CAN_JUMP_THRESHOLD, CAN_USE_LONG_THRESHOLD } = this.options.config.pageNavigator;
        this.data.navigation.required = isNestedPageData(pageData) && pageData.nestedEmbeds.length >= 2;
        this.data.navigation.canJump = isNestedPageData(pageData) && pageData.nestedEmbeds.length >= CAN_JUMP_THRESHOLD;
        this.data.navigation.canUseLong =
            isNestedPageData(pageData) && pageData.nestedEmbeds.length >= CAN_USE_LONG_THRESHOLD;
    }

    private callEventStack(event: PaginationEvent, ...args: any): void {
        if (!this.events[event].length) return;

        // Iterate through the event listeners
        for (let i = 0; i < this.events[event].length; i++) {
            // Execute the listener function
            this.events[event][i].listener.apply(null, args);
            // Remove once listeners
            if (this.events[event][i].once) this.events[event].splice(i, 1);
        }
    }

    private configure_navigation(): void {
        this.data.navigation.reactions = [];

        if (this.data.navigation.required) {
            let navTypes = [];

            // prettier-ignore
            switch (this.options.type) {
                case "short":
                    navTypes = ["back", "next"];                                                    // Short ( STATIC )
                    break;
    
                case "shortJump":
                    navTypes = this.options.dynamic
                        ? this.data.navigation.canJump
                            ? ["back", "jump", "next"]                                              // Short Jump ( DYNAMIC )
                            : ["back", "next"]                                                      // Short ( DYNAMIC )
                        : ["back", "jump", "next"];                                                 // Short Jump ( STATIC )
                    break;
    
                case "long":
                    navTypes = ["to_first", "back", "next", "to_last"];                             // Long ( STATIC )
                    break;
    
                case "longJump":
                    navTypes = this.options.dynamic
                        ? this.data.navigation.canJump
                            ? ["to_first", "back", "jump", "next", "to_last"]                       // Long Jump ( DYNAMIC )
                            : ["to_first", "back", "next", "to_last"]                               // Long ( DYNAMIC )
                        : ["to_first", "back", "jump", "next", "to_last"];                          // Long Jump ( STATIC )
                    break;
            }

            // Convert types to reactions/buttons
            if (this.options.useReactions) {
                /* as reactions */
                this.data.navigation.reactions = navTypes.map(
                    type =>
                        getProp(this.options.config.pageNavigator.buttons, `${type}.emoji`) as {
                            name: string;
                            id: string;
                        }
                );
            } else {
                /* as buttons */
                this.data.components.actionRows.navigation.setComponents(
                    ...navTypes.map(type => getProp(this.data.components.navigation, type) as ButtonBuilder)
                );
            }
        } else {
            // Delete all the buttons in the action row, so extra buttons don't get duplicated
            /* This is only needed if there are no navigation buttons in the action row */
            this.data.components.actionRows.navigation.setComponents([]);
        }

        // Add extra buttons, if any
        for (const btn of this.data.extraUserButtons) {
            this.data.components.actionRows.navigation.components.splice(btn.index, 0, btn.component);
        }
    }

    private configure_components(): void {
        this.data.messageActionRows = [];

        // Add select menu navigation, if needed
        if (this.data.selectMenu.optionIds.length) {
            this.data.components.actionRows.selectMenu.setComponents(this.data.components.selectMenu);
            this.data.messageActionRows.push(this.data.components.actionRows.selectMenu);
        }

        // Add button navigation, if needed
        if ((this.data.navigation.required && !this.options.useReactions) || this.data.extraUserButtons.length) {
            this.data.messageActionRows.push(this.data.components.actionRows.navigation);
        }
    }

    private configure_all(): void {
        this.setPage();
        this.configure_navigation();
        this.configure_components();
    }

    private async askPageNumber(requestedBy: GuildMember | User): Promise<number | null> {
        if (!this.data.message) throw new Error("[PageNavigator>#askPageNumber]: 'this.data.message' is undefined.");

        // prettier-ignore
        const _acf = (str: string, msg?: Message) => str
            .replace("$USER_MENTION", requestedBy.toString())
            .replace("$MESSAGE_CONTENT", msg?.content || "");

        let messageReply = await this.data.message
            .reply({ content: _acf(this.options.config.pageNavigator.ASK_PAGE_NUMBER_MESSAGE) })
            .catch(() => null);

        /* erorr */
        if (!messageReply) return null;

        /* - - - - - { Collect the next Messsage } - - - - - */
        const _timeouts = {
            confirm: parseTime(this.options.config.timeouts.CONFIRMATION),
            error: parseTime(this.options.config.timeouts.ERROR_MESSAGE)
        };

        let filter = (msg: Message) => (msg.author.id === requestedBy.id && msg.content.match(/^\d+$/) ? true : false);

        return await messageReply.channel
            .awaitMessages({ filter, max: 1, time: _timeouts.confirm })
            .then(collected => {
                let msg = collected.first();
                if (!msg) return null;

                /* NOTE: subtraction is to account for 0-based index */
                let chosenPageNumber = Number(msg.content) - 1;
                let fuckedUp = false;

                // Check if the chosen page number is within range
                if (chosenPageNumber > 0 && chosenPageNumber <= this.options.pages.length) {
                    fuckedUp = true;
                    dynaSend(msg, {
                        content: _acf(this.options.config.pageNavigator.ASK_PAGE_NUMBER_ERROR, msg),
                        deleteAfter: _timeouts.error
                    });
                }

                // Delete the user's reply
                if (msg.deletable) msg.delete().catch(Boolean);
                // Delete the message reply
                if (messageReply.deletable) messageReply.delete().catch(Boolean);

                return fuckedUp ? null : chosenPageNumber;
            })
            .catch(() => {
                // Delete the message reply
                if (messageReply.deletable) messageReply.delete().catch(Boolean);
                return null;
            });
    }

    private async navComponents_removeFromMessage(): Promise<void> {
        if (!this.data.message?.editable) return;
        await this.data.message.edit({ components: [] }).catch(Boolean);
    }

    private async navReactions_addToMessage(): Promise<void> {
        if (!this.data.message || !this.options.useReactions || !this.data.navigation.reactions.length) return;

        const reactionNames = Object.values(this.options.config.pageNavigator.buttons).map(d => d.emoji.name);

        // Get the current relevant reactions on the message
        let _reactions = this.data.message.reactions.cache.filter(r => reactionNames.includes(r.emoji.name || ""));

        // Check if the cached reactions are the same as the ones required
        if (_reactions.size !== this.data.navigation.reactions.length) {
            await this.navReactions_removeFromMessage();

            // React to the message
            for (let r of this.data.navigation.reactions) await this.data.message.react(r.id).catch(Boolean);
        }
    }

    private async navReactions_removeFromMessage(): Promise<void> {
        if (!this.data.message) return;
        await this.data.message.reactions.removeAll().catch(Boolean);
    }

    private async collect_components(): Promise<void> {
        if (!this.data.message) return;
        if (!this.data.messageActionRows.length) return;
        if (this.data.collectors.component) {
            this.data.collectors.component.resetTimer();
            return;
        }

        const allowedParticipantIds = this.options.allowedParticipants.map(m => (typeof m === "string" ? m : m.id));

        // Create the component collector
        const collector = this.data.message.createMessageComponentCollector({
            filter: i => (allowedParticipantIds.length ? allowedParticipantIds.includes(i.user.id) : true),
            ...(this.options.timeout ? { idle: this.options.timeout } : {})
        }) as InteractionCollector<ButtonInteraction | StringSelectMenuInteraction>;

        // Cache the collector
        this.data.collectors.component = collector;

        return new Promise(resolve => {
            // Collector ( COLLECT )
            collector.on("collect", async i => {
                // Ignore interactions that aren't StringSelectMenu/Button
                if (!i.isStringSelectMenu() && !i.isButton()) return;

                // Reset the collector's timer
                collector.resetTimer();

                // Call the 'collect' event stack
                this.callEventStack("collect", i, this.data.page.currentData, this.data.page.index);

                try {
                    switch (i.customId) {
                        case "ssm_pageSelect":
                            await i.deferUpdate().catch(Boolean);
                            let _ssmOptionIndex = this.data.selectMenu.optionIds.indexOf(
                                (i as StringSelectMenuInteraction).values[0]
                            );
                            this.setPage(_ssmOptionIndex);
                            this.callEventStack(
                                "selectMenuOptionPicked",
                                this.data.page.currentData,
                                this.data.components.selectMenu.options[_ssmOptionIndex],
                                this.data.page.index
                            );
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case "btn_to_first":
                            await i.deferUpdate().catch(Boolean);
                            this.setPage(this.data.page.index.current, 0);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case "btn_back":
                            await i.deferUpdate().catch(Boolean);
                            this.setPage(this.data.page.index.current, this.data.page.index.nested - 1);
                            this.callEventStack("pageBack", this.data.page.currentData, this.data.page.index.nested);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case "btn_jump":
                            await i.deferUpdate().catch(Boolean);
                            let jumpIndex = await this.askPageNumber(i.user);
                            if (jumpIndex === null) return;
                            this.setPage(this.data.page.index.current, jumpIndex);
                            this.callEventStack("pageJumped", this.data.page.currentData, this.data.page.index);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case "btn_next":
                            await i.deferUpdate().catch(Boolean);
                            this.setPage(this.data.page.index.current, this.data.page.index.nested + 1);
                            this.callEventStack("pageNext", this.data.page.currentData, this.data.page.index);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case "btn_to_last":
                            await i.deferUpdate().catch(Boolean);
                            this.setPage(this.data.page.index.current, this.options.pages.length - 1);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();
                    }
                } catch (err) {
                    console.error("[PageNavigator>#collectComponents]", err);
                }
            });

            // Collector ( END )
            collector.on("end", async () => {
                this.data.collectors.component = null;
                this.handlePostTimeout();
                resolve();
            });
        });
    }

    private async collect_reactions(): Promise<void> {
        if (!this.data.message) return;
        if (!this.data.navigation.reactions.length) return;
        if (this.data.collectors.reaction) {
            this.data.collectors.reaction.resetTimer();
            return;
        }

        const allowedParticipantIds = this.options.allowedParticipants.map(m => (typeof m === "string" ? m : m.id));

        // Create the component collector
        const collector = this.data.message.createReactionCollector({
            ...(this.options.timeout ? { idle: this.options.timeout } : {})
        });

        // Cache the collector
        this.data.collectors.reaction = collector;

        return new Promise(resolve => {
            // Collector ( COLLECT )
            collector.on("collect", async (reaction, user) => {
                // Ignore reactions that aren't part of our pagination
                if (!this.data.paginationReactionNames.includes(reaction.emoji.name || "")) return;

                // Remove the reaction unless it's from the bot itself
                if (user.id !== reaction.message.guild?.members?.me?.id) await reaction.users.remove(user.id);

                // Ignore reactions that weren't from the allowed users
                if (allowedParticipantIds.length && !allowedParticipantIds.includes(user.id)) return;

                // Reset the collector's timer
                collector.resetTimer();

                // Call the 'reaction' event stack
                this.callEventStack("react", reaction, user, this.data.page.currentData, this.data.page.index);

                try {
                    switch (reaction.emoji.name) {
                        case this.options.config.pageNavigator.buttons.to_first.emoji.name:
                            this.setPage(this.data.page.index.current, 0);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case this.options.config.pageNavigator.buttons.back.emoji.name:
                            this.setPage(this.data.page.index.current, this.data.page.index.nested - 1);
                            this.callEventStack("pageBack", this.data.page.currentData, this.data.page.index);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case this.options.config.pageNavigator.buttons.jump.emoji.name:
                            let jumpIndex = await this.askPageNumber(user);
                            if (jumpIndex === null) return;
                            this.setPage(this.data.page.index.current, jumpIndex);
                            this.callEventStack("pageJumped", this.data.page.currentData, this.data.page.index);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case this.options.config.pageNavigator.buttons.next.emoji.name:
                            this.setPage(this.data.page.index.current, this.data.page.index.nested + 1);
                            this.callEventStack("pageNext", this.data.page.currentData, this.data.page.index);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();

                        case this.options.config.pageNavigator.buttons.to_last.emoji.name:
                            this.setPage(this.data.page.index.current, this.options.pages.length - 1);
                            this.callEventStack("pageChanged", this.data.page.currentData, this.data.page.index);
                            return await this.refresh();
                    }
                } catch (err) {
                    console.error("[PageNavigator>#collectReactions]", err);
                }
            });

            // Collector ( END )
            collector.on("end", async () => {
                this.data.collectors.reaction = null;
                this.handlePostTimeout();
                resolve();
            });
        });
    }

    private async collect_all(): Promise<[void, void]> {
        return await Promise.all([this.collect_components(), this.collect_reactions()]);
    }

    private async handlePostTimeout(): Promise<void> {
        if (this.options.postTimeout.deleteMessage) {
            /* > error prevention ( START ) */
            // Get options that are not "deleteMessage"
            let _postTimeoutOptions = Object.entries(this.options.postTimeout)
                // Filter out "deleteMessage"
                .filter(([k, _]) => k !== "deleteMessage")
                // Filter out disabled ones
                .filter(([_, v]) => v)
                // Map only the keys
                .map(([k, _]) => k);

            // Check if any of them are enabled
            if (_postTimeoutOptions.length) {
                console.log(
                    `[PageNavigator>#handlePostTimeout]: ${_postTimeoutOptions
                        .map(k => `'${k}'`)
                        .join(", ")} has no effect when 'deleteMessage' is enabled.`
                );
            }
            /* > error prevention ( END ) */

            // Delete the message
            if (this.data.message?.deletable) this.data.message = await this.data.message.delete().catch(() => null);
        }

        if (this.data.message && this.data.message.editable && !this.options.postTimeout.deleteMessage) {
            // Disable components
            if (this.options.postTimeout.disableComponents) {
                this.data.messageActionRows.forEach(ar => ar.components.forEach(c => c.setDisabled(true)));
                this.data.message.edit({ components: this.data.messageActionRows }).catch(Boolean);
            }

            if (this.options.postTimeout.clearComponentsOrReactions) {
                if (!this.options.useReactions) {
                    // Clear message components
                    this.navComponents_removeFromMessage();
                } else {
                    // Clear message reactions
                    this.navReactions_removeFromMessage();
                }
            }
        }

        // Call events ( TIMEOUT )
        this.callEventStack("timeout", this.data.message);
    }

    constructor(options: PageNavigatorOptions) {
        /* - - - - - { Parse Options } - - - - - */
        this.options = {
            ...options,
            allowedParticipants: options.allowedParticipants ?? [],
            pages: this.resolveEmbedsToPages(options.pages),
            type: options.type || "short",
            useReactions: options.useReactions || false,
            dynamic: options.dynamic || false,
            timeout:
                typeof options.timeout === "string" || typeof options.timeout === "number"
                    ? parseTime(options.timeout)
                    : parseTime((options.config || djsConfig).timeouts.PAGINATION),
            config: options.config || djsConfig,
            postTimeout: {
                disableComponents: true,
                clearComponentsOrReactions: false,
                deleteMessage: false
            }
        };

        this.data = {
            paginationReactionNames: Object.values(this.options.config.pageNavigator.buttons).map(data => data.emoji.name),

            message: null,
            messageActionRows: [],
            extraUserButtons: [],

            page: {
                currentEmbed: null,
                currentData: null,
                currentMessageContent: undefined,
                index: { current: 0, nested: 0 }
            },

            selectMenu: {
                currentlySelected: null,
                optionIds: []
            },

            navigation: {
                reactions: [],
                required: false,
                canUseLong: false,
                canJump: false
            },

            collectors: {
                component: null,
                reaction: null
            },

            components: {
                actionRows: {
                    selectMenu: new ActionRowBuilder<StringSelectMenuBuilder>(),
                    navigation: new ActionRowBuilder<ButtonBuilder>()
                },

                selectMenu: new StringSelectMenuBuilder().setCustomId("ssm_pageSelect"),
                navigation: {
                    to_first: this.createButton({
                        custom_id: "btn_to_first",
                        ...this.options.config.pageNavigator.buttons.to_first
                    }),
                    back: this.createButton({ custom_id: "btn_back", ...this.options.config.pageNavigator.buttons.back }),
                    jump: this.createButton({ custom_id: "btn_jump", ...this.options.config.pageNavigator.buttons.jump }),
                    next: this.createButton({ custom_id: "btn_next", ...this.options.config.pageNavigator.buttons.next }),
                    to_last: this.createButton({
                        custom_id: "btn_to_last",
                        ...this.options.config.pageNavigator.buttons.to_last
                    })
                }
            }
        };

        this.events = {
            pageChanged: [],
            pageBack: [],
            pageNext: [],
            pageJumped: [],
            selectMenuOptionPicked: [],
            collect: [],
            react: [],
            timeout: []
        };

        /* - - - - - { Error Checking } - - - - - */
        if (!options.pages || (Array.isArray(options.pages) && !options.pages.length)) {
            throw new Error("[PageNavigator]: You must provide at least 1 page.");
        }

        // prettier-ignore
        if (options?.useReactions) {
            for (let [key, val] of Object.entries(this.options.config.pageNavigator.buttons)) {
                if (!val.emoji.id) throw new Error(`[PageNavigator]: \`${key}.id\` is an empty value; This is required to be able to add it as a reaction. Fix this in \'./this.options.config.json\'.`);
                if (!val.emoji.name) throw new Error(`[PageNavigator]: \`${key}.name\` is an empty value; This is required to determine which reaction a user reacted to. Fix this in \'./this.options.config.json\'.`);
            }
        }

        // Configure
        this.configure_all();
    }

    on(
        event: "pageChanged",
        listener: (page: PageData | NestedPageData, pageIndex: { current: number; nested: number }) => any,
        once?: boolean
    ): this;
    on(
        event: "pageBack",
        listener: (page: PageData | NestedPageData, pageIndex: { current: number; nested: number }) => any,
        once?: boolean
    ): this;
    on(
        event: "pageNext",
        listener: (page: PageData | NestedPageData, pageIndex: { current: number; nested: number }) => any,
        once?: boolean
    ): this;
    on(
        event: "pageJumped",
        listener: (page: PageData | NestedPageData, pageIndex: { current: number; nested: number }) => any,
        once?: boolean
    ): this;
    on(
        event: "selectMenuOptionPicked",
        listener: (
            page: PageData | NestedPageData,
            option: SelectMenuOptionData,
            pageIndex: { current: number; nested: number }
        ) => any,
        once?: boolean
    ): this;
    on<T extends CacheType>(
        event: "collect",
        listener: (
            interaction: StringSelectMenuInteraction<T> | ButtonInteraction<T>,
            page: PageData | NestedPageData,
            pageIndex: { current: number; nested: number }
        ) => any,
        once?: boolean
    ): this;
    on(
        event: "react",
        listener: (
            reaction: MessageReaction,
            user: User,
            page: PageData | NestedPageData,
            pageIndex: { current: number; nested: number }
        ) => any,
        once?: boolean
    ): this;
    on(event: "timeout", listener: (message: Message) => any, once?: boolean): this;
    on(event: PaginationEvent, listener: Function, once: boolean = false): this {
        this.events[event].push({ listener, once });
        return this;
    }

    /** Add one or more options to the select menu component. */
    addSelectMenuOptions(...options: SelectMenuOptionData[]): this {
        const ssm_options: StringSelectMenuOptionBuilder[] = [];

        for (let data of options) {
            /* error */
            if (!data.emoji && !data.label)
                throw new Error("[PageNavigator>addSelectMenuOptions]: Option must include either an emoji or a label.");

            // Set option defaults
            data = {
                emoji: data.emoji || "",
                label: data.label || `page ${this.data.selectMenu.optionIds.length + 1}`,
                description: data.description || "",
                value: data.value || `ssm_o_${this.data.selectMenu.optionIds.length + 1}`,
                default: data.default ?? this.data.selectMenu.optionIds.length === 0 ? true : false
            };

            // Create a new StringSelectMenuOption
            const ssm_option = new StringSelectMenuOptionBuilder({
                label: data.label,
                value: data.value as string,
                default: data.default
            });

            /// Set option properties, if available
            if (data.emoji) ssm_option.setEmoji(data.emoji);
            if (data.description) ssm_option.setDescription(data.description);

            // Add the new StringSelectMenuOption to the master array
            ssm_options.push(ssm_option);
            // Add the new option ID (value) to our optionIds array
            this.data.selectMenu.optionIds.push(data.value as string);
        }

        // Add the new options to the select menu
        this.data.components.selectMenu.addOptions(...ssm_options);
        return this;
    }

    /** Remove select menu options at the given index/indices.
     * ```ts
     * // Remove the options at index 0, 2, and 4
     * PageNavigator.removeSelectMenuOptions(0, 2, 4);
     *
     * // Remove the last option
     * PageNavigator.removeSelectMenuOptions(-1);
     * ``` */
    removeSelectMenuOptions(...index: number[]): this {
        index.forEach(i => this.data.components.selectMenu.spliceOptions(i, 1));
        return this;
    }

    /** Set the pagination type. */
    setPaginationType(type: PaginationType): this {
        this.options.type = type;
        return this;
    }

    /** Allows inserting a button at the given index in the same action row as the navigation buttons. */
    insertButtonAt(index: number, component: ButtonBuilder): this {
        /* error */
        if (this.data.components.actionRows.navigation.components.length === 5) {
            console.log(
                "[PageNavigator>insertButtonAt]: You cannot have more than 5 buttons in the same action row. Add a new ActionRow."
            );
        }

        this.data.extraUserButtons.push({ index, component });
        return this;
    }

    /** Remove buttons at the given index/indices.
     * ```ts
     * // Remove the button at index 0, 2, and 4
     * PageNavigator.removeButtonAt(0, 2, 4);
     *
     * // Remove the last button
     * PageNavigator.removeButtonAt(-1);
     * ``` */
    removeButtonAt(...index: number[]): this {
        index.forEach(i => this.data.extraUserButtons[this.data.extraUserButtons.findIndex(b => b.index === i)]);
        return this;
    }

    /** Send the PageNavigator. */
    async send(handler: SendHandler, options?: SendOptions): Promise<Message | null> {
        // Pre-configure
        this.configure_all();

        // Send with dynaSend
        this.data.message = await dynaSend(handler, {
            ...options,
            content: this.data.page.currentMessageContent,
            embeds: this.data.page.currentEmbed!,
            components: this.data.messageActionRows,
            withResponse: true
        });

        if (this.data.message) {
            // Add reactions, if applicable
            /* NOTE: this is not awaited so we're able to interact with the reactions before they're fully added */
            this.navReactions_addToMessage();

            // Start collectors
            this.collect_all();
        }

        // Return the message, if it exists
        return this.data.message;
    }

    /** Refresh the current page embed, navigation, and collectors. */
    async refresh(): Promise<Message | null> {
        /* > error prevention ( START ) */
        if (!this.data.message) {
            console.log("[PageNavigator>refresh]: Could not refresh navigator; message not sent.");
            return null;
        }
        if (!this.data.message.editable) {
            console.log("[PageNavigator>refresh]: Could not refresh navigator; message not editable.");
            return null;
        }
        /* > error prevention ( END ) */

        // Pre-configure
        this.configure_all();

        // Edit the message with dynaSend
        this.data.message = await dynaSend(this.data.message, {
            sendMethod: "messageEdit",
            content: this.data.page.currentMessageContent,
            embeds: this.data.page.currentEmbed!,
            components: this.data.messageActionRows,
            withResponse: true
        });

        if (this.data.message) {
            // Refresh reactions, if applicable
            /* NOTE: this is not awaited so we're able to interact with the reactions before they're fully added */
            this.navReactions_removeFromMessage().then(() => this.navReactions_addToMessage());
        }

        // Return the message, if it exists
        return this.data.message;
    }
}
