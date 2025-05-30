const {
    ticketsCollection
} = require('../mongodb');
const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    PermissionsBitField,
    ChannelType,
    MessageFlagsBits
} = require('discord.js');
const ticketIcons = require('../UI/icons/ticketicons');

let config = {};

async function loadConfig() {
    try {
        const tickets = await ticketsCollection.find({}).toArray();
        config.tickets = tickets.reduce((acc, ticket) => {
            acc[ticket.serverId] = {
                ticketChannelId: ticket.ticketChannelId,
                adminRoleId: ticket.adminRoleId,
                status: ticket.status
            };
            return acc;
        }, {});
    } catch (err) {
        console.error('Error loading config from MongoDB:', err);
    }
}

setInterval(loadConfig, 5000);

module.exports = (client) => {
    client.on('ready', async () => {
        try {
            await loadConfig();
            monitorConfigChanges(client);
        } catch (error) {
            console.error('Error during client ready event:', error);
        }
    });

    client.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.isStringSelectMenu() && interaction.customId === 'select_ticket_type') {
                handleSelectMenu(interaction, client);
            } else if (interaction.isButton() && interaction.customId.startsWith('close_ticket_')) {
                handleCloseButton(interaction, client);
            }
        } catch (error) {
            console.error('Error handling interaction:', error);
        }
    });
};

async function monitorConfigChanges(client) {
    let previousConfig = JSON.parse(JSON.stringify(config));

    setInterval(async () => {
        try {
            await loadConfig();
            if (JSON.stringify(config) !== JSON.stringify(previousConfig)) {
                for (const guildId of Object.keys(config.tickets)) {
                    const settings = config.tickets[guildId];
                    const previousSettings = previousConfig.tickets[guildId];

                    if (
                        settings &&
                        settings.status &&
                        settings.ticketChannelId &&
                        (!previousSettings || settings.ticketChannelId !== previousSettings.ticketChannelId)
                    ) {
                        const guild = client.guilds.cache.get(guildId);
                        if (!guild) continue;

                        const ticketChannel = guild.channels.cache.get(settings.ticketChannelId);
                        if (!ticketChannel) continue;

                        const embed = new EmbedBuilder()
                            .setAuthor({
                                name: "Welcome to Ticket Support",
                                iconURL: ticketIcons.mainIcon,
                                url: "https://discord.gg/83MXaWxbWc"
                            })
                            .setDescription(
                                '- Please click below menu to create a new ticket.\n\n' +
                                '**Ticket Guidelines:**\n' +
                                '- Empty tickets are not permitted.\n' +
                                '- Please be patient while waiting for a response from our support team.'
                            )
                            .setFooter({ text: 'We are here to Help!', iconURL: ticketIcons.modIcon })
                            .setColor('#00FF00')
                            .setTimestamp();

                        const menu = new StringSelectMenuBuilder()
                            .setCustomId('select_ticket_type')
                            .setPlaceholder('Choose ticket type')
                            .addOptions([
                                { label: '🆘 Support', value: 'support' },
                                { label: '📂 Suggestion', value: 'suggestion' },
                                { label: '💜 Feedback', value: 'feedback' },
                                { label: '⚠️ Report', value: 'report' }
                            ]);

                        const row = new ActionRowBuilder().addComponents(menu);

                        try {
                            await ticketChannel.send({
                                embeds: [embed],
                                components: [row]
                            });
                        } catch (sendError) {
                            console.error("Error sending ticket menu message:", sendError);
                        }

                        previousConfig = JSON.parse(JSON.stringify(config));
                    }
                }
            }
        } catch (error) {
            console.error("Error in monitorConfigChanges:", error);
        }
    }, 5000);
}

async function handleSelectMenu(interaction, client) {
    try {
        await interaction.deferReply({ flags: 64 });
    } catch (error) {
        console.error("Error deferring reply:", error);
    }

    const { guild, user, values } = interaction;
    if (!guild || !user) return;

    const guildId = guild.id;
    const userId = user.id;
    const ticketType = values[0];
    const settings = config.tickets[guildId];
    if (!settings) return;

    try {
        const ticketExists = await ticketsCollection.findOne({ guildId, userId });
        if (ticketExists) {
            return interaction.followUp({
                content: 'You already have an open ticket.',
                flags: 64
            });
        }
    } catch (error) {
        console.error("Error checking for existing ticket:", error);
    }

    let ticketChannel;
    try {
        ticketChannel = await guild.channels.create({
            name: `${user.username}-${ticketType}-ticket`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    deny: [PermissionsBitField.Flags.ViewChannel]
                },
                {
                    id: userId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory
                    ]
                },
                {
                    id: settings.adminRoleId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory
                    ]
                }
            ]
        });
    } catch (error) {
        console.error("Error creating ticket channel:", error);
        return interaction.followUp({
            content: "Failed to create ticket channel due to missing permissions or other errors.",
            flags: 64
        });
    }

    const ticketId = `${guildId}-${ticketChannel.id}`;
    try {
        await ticketsCollection.insertOne({ id: ticketId, channelId: ticketChannel.id, guildId, userId, type: ticketType });
    } catch (error) {
        console.error("Error inserting ticket into the database:", error);
    }

    const ticketEmbed = new EmbedBuilder()
        .setAuthor({
            name: "Support Ticket",
            iconURL: ticketIcons.modIcon,
            url: "https://discord.gg/83MXaWxbWc"
        })
        .setDescription(
            `Hello ${user}, welcome to our support!\n- Please provide a detailed description of your issue\n- Our support team will assist you as soon as possible.\n- Feel free to open another ticket if this one is closed.`
        )
        .setFooter({ text: 'Your satisfaction is our priority', iconURL: ticketIcons.heartIcon })
        .setColor('#00FF00')
        .setTimestamp();

    const closeButton = new ButtonBuilder()
        .setCustomId(`close_ticket_${ticketId}`)
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger);

    const actionRow = new ActionRowBuilder().addComponents(closeButton);

    try {
        await ticketChannel.send({
            content: `${user}`,
            embeds: [ticketEmbed],
            components: [actionRow]
        });
    } catch (error) {
        console.error("Error sending message in the ticket channel:", error);
    }

    const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setAuthor({
            name: "Ticket Created!",
            iconURL: ticketIcons.correctIcon,
            url: "https://discord.gg/83MXaWxbWc"
        })
        .setDescription(`- Your ${ticketType} ticket has been created.`)
        .addFields(
            { name: 'Ticket Channel', value: `${ticketChannel.url}` },
            { name: 'Instructions', value: 'Please describe your issue in detail.' }
        )
        .setTimestamp()
        .setFooter({ text: 'Thank you for reaching out!', iconURL: ticketIcons.modIcon });

    try {
        await user.send({
            content: `Your ${ticketType} ticket has been created`,
            embeds: [embed]
        });
    } catch (error) {
        console.error("Error sending DM to user:", error);
    }

    try {
        await interaction.followUp({
            content: 'Ticket created!',
            flags: 64
        });
    } catch (error) {
        console.error("Error sending follow-up message:", error);
    }
}

async function handleCloseButton(interaction, client) {
    try {
        await interaction.deferReply({ flags: 64 });
    } catch (error) {
        console.error("Error deferring reply in close button:", error);
    }

    const ticketId = interaction.customId.replace('close_ticket_', '');
    const { guild, user } = interaction;
    if (!guild || !user) return;

    let ticket;
    try {
        ticket = await ticketsCollection.findOne({ id: ticketId });
    } catch (error) {
        console.error("Error finding ticket in the database:", error);
    }
    if (!ticket) {
        return interaction.followUp({
            content: 'Ticket not found. Please report to staff!',
            flags: 64
        });
    }

    const ticketChannel = guild.channels.cache.get(ticket.channelId);
    if (ticketChannel) {
        setTimeout(async () => {
            try {
                await ticketChannel.delete();
            } catch (error) {
                console.error("Error deleting ticket channel:", error);
            }
        }, 5000);
    }

    try {
        await ticketsCollection.deleteOne({ id: ticketId });
    } catch (error) {
        console.error("Error deleting ticket from the database:", error);
    }

    let ticketUser;
    try {
        ticketUser = await client.users.fetch(ticket.userId);
    } catch (error) {
        console.error("Error fetching ticket user:", error);
    }
    if (ticketUser) {
        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setAuthor({
                name: "Ticket closed!",
                iconURL: ticketIcons.correctrIcon,
                url: "https://discord.gg/83MXaWxbWc"
            })
            .setDescription(`- Your ticket has been closed.`)
            .setTimestamp()
            .setFooter({ text: 'Thank you for reaching out!', iconURL: ticketIcons.modIcon });

        try {
            await ticketUser.send({
                content: `Your ticket has been closed.`,
                embeds: [embed]
            });
        } catch (error) {
            console.error("Error sending DM to ticket user:", error);
        }
    }

    try {
        await interaction.followUp({
            content: 'Ticket closed and user notified.',
            flags: 64
        });
    } catch (error) {
        console.error("Error sending follow-up for ticket closure:", error);
    }
}
