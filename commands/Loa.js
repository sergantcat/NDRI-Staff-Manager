require('dotenv').config({ quiet: true });

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { Pool } = require('pg');

const CUSTOM_IDS = {
  requestButton: 'loa:request',
  requestModal: 'loa:request-modal',
  approvePrefix: 'loa:approve:',
  denyPrefix: 'loa:deny:',
};

const STATUS = {
  pending: 'pending',
  approved: 'approved',
  denied: 'denied',
  ended: 'ended',
};

const data = new SlashCommandBuilder()
  .setName('loa')
  .setDescription('Manage staff leave of absence')
  .addSubcommand(subcommand =>
    subcommand
      .setName('setup-panels')
      .setDescription('Post LOA request panels in the staff and developer LOA channels'),
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('request')
      .setDescription('Request a leave of absence for yourself')
      .addStringOption(option =>
        option
          .setName('time')
          .setDescription('How long the LOA will last')
          .setRequired(true),
      )
      .addStringOption(option =>
        option
          .setName('reason')
          .setDescription('Reason for the LOA')
          .setRequired(false),
      ),
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('end')
      .setDescription('End your LOA early, or end another user LOA if you are an approver')
      .addUserOption(option =>
        option
          .setName('user')
          .setDescription('User whose LOA should be ended')
          .setRequired(false),
      ),
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('view')
      .setDescription('View LOA status for yourself or another user')
      .addUserOption(option =>
        option
          .setName('user')
          .setDescription('User to view')
          .setRequired(false),
      ),
  );

let pool;
let dbReady;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is missing from .env');
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }

  return pool;
}

async function ensureDatabase() {
  if (!dbReady) {
    dbReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS loa_requests (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        request_channel_id TEXT NOT NULL,
        request_message_id TEXT,
        duration TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by TEXT,
        ended_at TIMESTAMPTZ,
        ended_by TEXT,
        original_nickname TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_loa_requests_user_status
        ON loa_requests (guild_id, user_id, status);
    `);
  }

  await dbReady;
}

function envList(name) {
  return (process.env[name] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function hasAnyRole(member, roleIds) {
  return roleIds.some(roleId => member.roles.cache.has(roleId));
}

function isApprover(member) {
  const approverRoleIds = envList('LOA_APPROVER_ROLE_IDS');
  return hasAnyRole(member, approverRoleIds);
}

function loaPanelEmbed(type) {
  return new EmbedBuilder()
    .setColor(type === 'dev' ? 0x5865f2 : 0x2ecc71)
    .setTitle(type === 'dev' ? 'Developer LOA Requests' : 'Staff LOA Requests')
    .setDescription('Use the button below to request a leave of absence.')
    .setTimestamp();
}

function requestButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.requestButton)
      .setLabel('Request LOA')
      .setStyle(ButtonStyle.Primary),
  );
}

function decisionRow(requestId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.approvePrefix}${requestId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.denyPrefix}${requestId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  );
}

function loaRequestEmbed({ user, duration, reason, status = STATUS.pending }) {
  const colors = {
    [STATUS.pending]: 0xf1c40f,
    [STATUS.approved]: 0x2ecc71,
    [STATUS.denied]: 0xe74c3c,
    [STATUS.ended]: 0x95a5a6,
  };

  return new EmbedBuilder()
    .setColor(colors[status] || colors[STATUS.pending])
    .setTitle(`LOA ${status.charAt(0).toUpperCase()}${status.slice(1)}`)
    .addFields(
      { name: 'User', value: `${user}`, inline: true },
      { name: 'Duration', value: duration, inline: true },
      { name: 'Reason', value: reason },
    )
    .setTimestamp();
}

function loaViewEmbed(user, rows) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('LOA View')
    .setDescription(`${user}`)
    .setTimestamp();

  if (!rows.length) {
    embed.addFields({ name: 'Requests', value: 'No LOA requests found.' });
    return embed;
  }

  embed.addFields(
    rows.slice(0, 10).map(row => ({
      name: `#${row.id} - ${row.status}`,
      value: [
        `Duration: ${row.duration}`,
        `Reason: ${row.reason}`,
        `Requested: <t:${Math.floor(new Date(row.requested_at).getTime() / 1000)}:R>`,
      ].join('\n'),
    })),
  );

  return embed;
}

function requestModal() {
  return new ModalBuilder()
    .setCustomId(CUSTOM_IDS.requestModal)
    .setTitle('Request LOA')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('How long will your LOA last?')
          .setPlaceholder('Example: 7 days, until June 24, 2026')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );
}

async function createRequest(interaction, duration, reason) {
  await ensureDatabase();

  const existing = await getPool().query(
    `SELECT id FROM loa_requests
     WHERE guild_id = $1 AND user_id = $2 AND status IN ($3, $4)
     ORDER BY requested_at DESC
     LIMIT 1`,
    [interaction.guildId, interaction.user.id, STATUS.pending, STATUS.approved],
  );

  if (existing.rowCount) {
    await interaction.reply({
      content: 'You already have a pending or approved LOA request.',
      ephemeral: true,
    });
    return;
  }

  const result = await getPool().query(
    `INSERT INTO loa_requests (guild_id, user_id, request_channel_id, duration, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [interaction.guildId, interaction.user.id, interaction.channelId, duration, reason],
  );

  const requestId = result.rows[0].id;
  const embed = loaRequestEmbed({
    user: interaction.user,
    duration,
    reason,
    status: STATUS.pending,
  });

  const message = await interaction.channel.send({
    embeds: [embed],
    components: [decisionRow(requestId)],
  });

  await getPool().query(
    'UPDATE loa_requests SET request_message_id = $1 WHERE id = $2',
    [message.id, requestId],
  );

  await interaction.reply({
    content: 'Your LOA request has been sent for approval.',
    ephemeral: true,
  });
}

async function applyApprovedLoa(member, requestId, reviewerId) {
  const loaRoleId = process.env.LOA_ROLE_ID;
  const originalNickname = member.nickname || member.user.username;

  if (loaRoleId) {
    await member.roles.add(loaRoleId, `LOA request #${requestId} approved`);
  }

  if (!member.displayName.startsWith('[LOA]')) {
    await member.setNickname(`[LOA] ${member.displayName}`, `LOA request #${requestId} approved`);
  }

  await getPool().query(
    `UPDATE loa_requests
     SET status = $1, reviewed_at = NOW(), reviewed_by = $2, original_nickname = $3
     WHERE id = $4`,
    [STATUS.approved, reviewerId, originalNickname, requestId],
  );
}

async function removeApprovedLoa(member, requestId, endedBy) {
  const loaRoleId = process.env.LOA_ROLE_ID;

  if (loaRoleId && member.roles.cache.has(loaRoleId)) {
    await member.roles.remove(loaRoleId, `LOA request #${requestId} ended`);
  }

  const result = await getPool().query(
    'SELECT original_nickname FROM loa_requests WHERE id = $1',
    [requestId],
  );
  const originalNickname = result.rows[0]?.original_nickname;

  if (member.displayName.startsWith('[LOA]')) {
    const fallbackName = member.displayName.replace(/^\[LOA\]\s*/i, '');
    await member.setNickname(originalNickname || fallbackName || null, `LOA request #${requestId} ended`);
  }

  await getPool().query(
    `UPDATE loa_requests
     SET status = $1, ended_at = NOW(), ended_by = $2
     WHERE id = $3`,
    [STATUS.ended, endedBy, requestId],
  );
}

async function updateDecisionMessage(interaction, request, status) {
  const user = await interaction.client.users.fetch(request.user_id);
  const embed = loaRequestEmbed({
    user,
    duration: request.duration,
    reason: request.reason,
    status,
  }).addFields({ name: 'Reviewed By', value: `${interaction.user}`, inline: true });

  await interaction.update({
    embeds: [embed],
    components: [],
  });
}

async function handleDecision(interaction, status) {
  if (!isApprover(interaction.member)) {
    await interaction.reply({
      content: 'You do not have one of the configured LOA approver roles.',
      ephemeral: true,
    });
    return;
  }

  await ensureDatabase();

  const requestId = Number(interaction.customId.split(':').pop());
  const result = await getPool().query(
    'SELECT * FROM loa_requests WHERE id = $1 AND guild_id = $2',
    [requestId, interaction.guildId],
  );
  const request = result.rows[0];

  if (!request || request.status !== STATUS.pending) {
    await interaction.reply({
      content: 'That LOA request is no longer pending.',
      ephemeral: true,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(request.user_id);

  if (status === STATUS.approved) {
    await applyApprovedLoa(member, requestId, interaction.user.id);
  } else {
    await getPool().query(
      `UPDATE loa_requests
       SET status = $1, reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $3`,
      [STATUS.denied, interaction.user.id, requestId],
    );
  }

  await updateDecisionMessage(interaction, request, status);

  await member.send({
    embeds: [
      loaRequestEmbed({
        user: member.user,
        duration: request.duration,
        reason: request.reason,
        status,
      }),
    ],
  }).catch(() => null);
}

async function setupPanels(interaction) {
  const canManageGuild = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

  if (!canManageGuild && !isApprover(interaction.member)) {
    await interaction.reply({
      content: 'You need Manage Server or an LOA approver role to post LOA panels.',
      ephemeral: true,
    });
    return;
  }

  const channels = [
    { id: process.env.STAFF_LOA_CHANNEL_ID, type: 'staff' },
    { id: process.env.DEV_LOA_CHANNEL_ID, type: 'dev' },
  ].filter(channel => channel.id);

  if (channels.length !== 2) {
    await interaction.reply({
      content: 'Set both STAFF_LOA_CHANNEL_ID and DEV_LOA_CHANNEL_ID in .env first.',
      ephemeral: true,
    });
    return;
  }

  const posted = [];

  for (const channelConfig of channels) {
    const channel = await interaction.guild.channels.fetch(channelConfig.id);

    if (!channel || channel.type !== ChannelType.GuildText) {
      posted.push(`Could not post ${channelConfig.type} panel: invalid text channel.`);
      continue;
    }

    await channel.send({
      embeds: [loaPanelEmbed(channelConfig.type)],
      components: [requestButtonRow()],
    });
    posted.push(`Posted ${channelConfig.type} panel in ${channel}.`);
  }

  await interaction.reply({ content: posted.join('\n'), ephemeral: true });
}

async function endLoa(interaction) {
  await ensureDatabase();

  const requestedUser = interaction.options.getUser('user');
  const targetUser = requestedUser || interaction.user;

  if (requestedUser && requestedUser.id !== interaction.user.id && !isApprover(interaction.member)) {
    await interaction.reply({
      content: 'Only configured LOA approvers can end LOA for another user.',
      ephemeral: true,
    });
    return;
  }

  const result = await getPool().query(
    `SELECT * FROM loa_requests
     WHERE guild_id = $1 AND user_id = $2 AND status = $3
     ORDER BY reviewed_at DESC
     LIMIT 1`,
    [interaction.guildId, targetUser.id, STATUS.approved],
  );
  const request = result.rows[0];

  if (!request) {
    await interaction.reply({
      content: `${targetUser} does not have an approved LOA to end.`,
      ephemeral: true,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(targetUser.id);
  await removeApprovedLoa(member, request.id, interaction.user.id);

  await interaction.reply({
    embeds: [
      loaRequestEmbed({
        user: targetUser,
        duration: request.duration,
        reason: request.reason,
        status: STATUS.ended,
      }),
    ],
  });
}

async function viewLoa(interaction) {
  await ensureDatabase();

  const targetUser = interaction.options.getUser('user') || interaction.user;
  const result = await getPool().query(
    `SELECT id, duration, reason, status, requested_at
     FROM loa_requests
     WHERE guild_id = $1 AND user_id = $2
     ORDER BY requested_at DESC
     LIMIT 10`,
    [interaction.guildId, targetUser.id],
  );

  await interaction.reply({
    embeds: [loaViewEmbed(targetUser, result.rows)],
    ephemeral: true,
  });
}

module.exports = {
  data,
  Data: data,

  async execute(interaction) {
    try {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'setup-panels') {
        await setupPanels(interaction);
        return;
      }

      if (subcommand === 'request') {
        const duration = interaction.options.getString('time');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await createRequest(interaction, duration, reason);
        return;
      }

      if (subcommand === 'end') {
        await endLoa(interaction);
        return;
      }

      if (subcommand === 'view') {
        await viewLoa(interaction);
      }
    } catch (error) {
      console.error(error);

      const response = {
        content: `LOA command failed: ${error.message}`,
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
      } else {
        await interaction.reply(response);
      }
    }
  },

  async handleInteraction(interaction) {
    try {
      if (interaction.isButton() && interaction.customId === CUSTOM_IDS.requestButton) {
        await interaction.showModal(requestModal());
        return true;
      }

      if (interaction.isModalSubmit() && interaction.customId === CUSTOM_IDS.requestModal) {
        const duration = interaction.fields.getTextInputValue('duration');
        const reason = interaction.fields.getTextInputValue('reason') || 'No reason provided';
        await createRequest(interaction, duration, reason);
        return true;
      }

      if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.approvePrefix)) {
        await handleDecision(interaction, STATUS.approved);
        return true;
      }

      if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.denyPrefix)) {
        await handleDecision(interaction, STATUS.denied);
        return true;
      }

      return false;
    } catch (error) {
      console.error(error);

      const response = {
        content: `LOA interaction failed: ${error.message}`,
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
      } else {
        await interaction.reply(response);
      }

      return true;
    }
  },
};
