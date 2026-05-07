/**
 * Bot Execution Service
 * 
 * Processes incoming messages against enabled bot flows.
 * When a trigger matches, executes action nodes in sequence.
 */

const { BotFlow, BotExecution, Chat, User, Message } = require('../models');
const whatsappService = require('./whatsapp.service');
const { logger } = require('../utils/logger');

/**
 * Main entry: evaluate all enabled bot flows against incoming message context.
 * Called from webhook.service.js after a message is saved.
 */
async function processIncomingMessage({ waba, phoneNumberId, chat, message, text }) {
    try {
        // Fetch all enabled flows
        const flows = await BotFlow.find({ isEnabled: true }).lean();
        if (!flows.length) return;

        for (const flow of flows) {
            const triggerResult = evaluateTrigger(flow.trigger, { chat, message, text });
            if (triggerResult.matched) {
                const matchedKeyword = triggerResult.matchedKeyword || '';

                // Cooldown check: skip if this flow ran for this chat within the cooldown window
                // For keyword-based triggers (on_message with keywords), we default to 1440 minutes (24 hours) if not specified.
                const isKeywordTrigger = flow.trigger?.type === 'on_message' && flow.trigger?.keywords?.length > 0;
                const cooldownMinutes = (flow.cooldownMinutes && flow.cooldownMinutes > 0) ? flow.cooldownMinutes : (isKeywordTrigger ? 1440 : 0);
                
                if (cooldownMinutes > 0) {
                    const cooldownSince = new Date(Date.now() - cooldownMinutes * 60 * 1000);
                    
                    const recentExecution = await BotExecution.findOne({
                        flowId: flow._id,
                        chatId: chat._id,
                        status: { $in: ['completed', 'running'] },
                        startedAt: { $gte: cooldownSince },
                    }).lean();

                    if (recentExecution) {
                        logger.info(`Bot flow "${flow.name}" skipped for chat ${chat._id} (ID: ${chat.waId}) — cooldown active (${cooldownMinutes}min).`);
                        continue; // Try next flow instead of breaking
                    }
                }

                logger.info(`Bot flow "${flow.name}" (${flow._id}) triggered for chat ${chat._id} [keyword: "${matchedKeyword || 'none'}"]`);
                // Execute flow asynchronously (fire-and-forget, but log errors)
                executeFlow(flow, { waba, phoneNumberId, chat, message, text, matchedKeyword })
                    .catch(err => logger.error(`Bot flow execution error for "${flow.name}":`, err.message));
                // Only execute the first matching flow
                break;
            }
        }
    } catch (err) {
        logger.error('Bot processIncomingMessage error:', err.message);
    }
}

/**
 * Evaluate trigger for open-conversation events.
 * Called from webhook when a new chat is opened.
 */
async function processOpenConversation({ waba, phoneNumberId, chat, message, text }) {
    try {
        const flows = await BotFlow.find({ isEnabled: true, 'trigger.type': 'on_open_conversation' }).lean();
        for (const flow of flows) {
            logger.info(`Bot flow "${flow.name}" triggered on open conversation for chat ${chat._id}`);
            executeFlow(flow, { waba, phoneNumberId, chat, message, text })
                .catch(err => logger.error(`Bot flow execution error:`, err.message));
            break;
        }
    } catch (err) {
        logger.error('Bot processOpenConversation error:', err.message);
    }
}

/**
 * Evaluate trigger for close-conversation events.
 */
async function processCloseConversation({ waba, phoneNumberId, chat }) {
    try {
        const flows = await BotFlow.find({ isEnabled: true, 'trigger.type': 'on_close_conversation' }).lean();
        for (const flow of flows) {
            logger.info(`Bot flow "${flow.name}" triggered on close conversation for chat ${chat._id}`);
            executeFlow(flow, { waba, phoneNumberId, chat, message: null, text: '' })
                .catch(err => logger.error(`Bot flow execution error:`, err.message));
            break;
        }
    } catch (err) {
        logger.error('Bot processCloseConversation error:', err.message);
    }
}

/**
 * Evaluate trigger for agent assignment events.
 */
async function processAgentAssign({ waba, phoneNumberId, chat, agentId }) {
    try {
        const flows = await BotFlow.find({ isEnabled: true, 'trigger.type': 'on_agent_assign' }).lean();
        for (const flow of flows) {
            logger.info(`Bot flow "${flow.name}" triggered on agent assign for chat ${chat._id}`);
            executeFlow(flow, { waba, phoneNumberId, chat, message: null, text: '', agentId })
                .catch(err => logger.error(`Bot flow execution error:`, err.message));
            break;
        }
    } catch (err) {
        logger.error('Bot processAgentAssign error:', err.message);
    }
}

/**
 * Check if a trigger matches the context.
 * Returns { matched: boolean, matchedKeyword?: string }
 */
function evaluateTrigger(trigger, { chat, message, text }) {
    if (!trigger || !trigger.type) return { matched: false };

    switch (trigger.type) {
        case 'on_message': {
            // If no keywords defined, match ALL messages
            if (!trigger.keywords || trigger.keywords.length === 0) return { matched: true };
            if (!text) return { matched: false };
            const lowerText = text.toLowerCase().trim();
            for (const keyword of trigger.keywords) {
                const lowerKeyword = keyword.toLowerCase().trim();
                if (!lowerKeyword) continue;
                let keywordMatched = false;
                switch (trigger.matchType) {
                    case 'exact':
                        keywordMatched = lowerText === lowerKeyword;
                        break;
                    case 'regex':
                        try { keywordMatched = new RegExp(keyword, 'i').test(text); }
                        catch { keywordMatched = false; }
                        break;
                    case 'partial':
                    default:
                        keywordMatched = lowerText.includes(lowerKeyword);
                        break;
                }
                if (keywordMatched) {
                    return { matched: true, matchedKeyword: lowerKeyword };
                }
            }
            return { matched: false };
        }
        case 'on_first_daily_message': {
            // Match if no message was sent by customer today
            if (!chat.lastCustomerMessageAt) return { matched: true };
            const today = new Date();
            const lastMsg = new Date(chat.lastCustomerMessageAt);
            return { matched: lastMsg.toDateString() !== today.toDateString() };
        }
        case 'on_new_lead': {
            // Triggered when chat is completely new (no previous messages)
            return { matched: true }; // Only called for new chats
        }
        case 'on_open_conversation':
        case 'on_close_conversation':
        case 'on_agent_assign':
            return { matched: true }; // These are event-based, already filtered by caller
        default:
            return { matched: false };
    }
}

/**
 * Execute a full bot flow: walk through nodes via edges.
 */
async function executeFlow(flow, context) {
    const { waba, phoneNumberId, chat, message, text, matchedKeyword } = context;
    const nodeMap = {};
    const edgeMap = {}; // source -> [edges]

    // Build lookup maps
    for (const node of (flow.nodes || [])) {
        nodeMap[node.id] = node;
    }
    for (const edge of (flow.edges || [])) {
        if (!edgeMap[edge.source]) edgeMap[edge.source] = [];
        edgeMap[edge.source].push(edge);
    }

    // Create execution record (with matched keyword for cooldown tracking)
    const execution = await BotExecution.create({
        flowId: flow._id,
        chatId: chat._id,
        status: 'running',
        startedAt: new Date(),
        matchedKeyword: matchedKeyword || '',
        executionLog: [],
    });

    try {
        // Find the trigger node (starting point)
        const triggerNode = (flow.nodes || []).find(n => n.type === 'trigger');
        if (!triggerNode) {
            logger.warn(`Bot flow "${flow.name}" has no trigger node`);
            await finishExecution(execution, 'failed');
            return;
        }

        // Recursive node walker that handles multiple branches
        const visited = new Set();
        let totalSteps = 0;
        const maxSteps = 50;

        async function walkNode(nodeId) {
            if (!nodeId || totalSteps >= maxSteps) return;
            if (visited.has(nodeId)) {
                logger.warn(`Bot flow "${flow.name}": cycle detected at node ${nodeId}`);
                return;
            }
            visited.add(nodeId);
            totalSteps++;

            const node = nodeMap[nodeId];
            if (!node) return;

            // Execute node action (skip trigger node itself)
            if (node.type !== 'trigger') {
                try {
                    const result = await executeNode(node, { waba, phoneNumberId, chat, message, text, flow });
                    execution.executionLog.push({
                        nodeId: node.id,
                        action: node.type,
                        result: result,
                        timestamp: new Date(),
                    });
                    execution.currentNodeId = node.id;

                    // If condition node, choose only the matching branch
                    if (node.type === 'condition' || node.type === 'working_hours_condition') {
                        const edges = edgeMap[nodeId] || [];
                        const branch = result?.branch || 'yes';
                        const matchedEdge = edges.find(e => e.sourceHandle === branch) || edges[0];
                        if (matchedEdge) {
                            await walkNode(matchedEdge.target);
                        }
                        return;
                    }
                } catch (nodeErr) {
                    logger.error(`Bot flow "${flow.name}" node "${node.type}" (${node.id}) error: ${nodeErr.message}`);
                    execution.executionLog.push({
                        nodeId: node.id,
                        action: node.type,
                        result: { error: nodeErr.message },
                        timestamp: new Date(),
                    });
                    // Continue to next branches even if this node fails
                }
            }

            // Follow ALL edges from this node (supports branching)
            const edges = edgeMap[nodeId] || [];
            for (const edge of edges) {
                await walkNode(edge.target);
            }
        }

        await walkNode(triggerNode.id);

        await finishExecution(execution, 'completed');
        logger.info(`Bot flow "${flow.name}" completed for chat ${chat._id}`);

    } catch (err) {
        execution.executionLog.push({
            nodeId: execution.currentNodeId || 'unknown',
            action: 'error',
            result: { error: err.message },
            timestamp: new Date(),
        });
        await finishExecution(execution, 'failed');
        throw err;
    }
}

/**
 * Execute a single node action.
 */
async function executeNode(node, context) {
    const { waba, phoneNumberId, chat, message, text, flow } = context;
    const config = node.config || {};

    switch (node.type) {
        case 'send_message': {
            if (!config.text && !config.imageUrl) return { skipped: true, reason: 'No message text or image configured' };

            // If an image URL is provided, send as media message
            if (config.imageUrl) {
                const waResult = await whatsappService.sendMediaMessage(
                    waba._id, phoneNumberId, chat.waId, 'image', config.imageUrl, config.text || ''
                );
                const msgId = waResult?.messages?.[0]?.id;
                await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'image', config.text || '', {
                    mediaUrl: config.imageUrl,
                });
                return { sent: true, messageId: msgId, type: 'image' };
            }

            // Plain text message
            const waResult = await whatsappService.sendTextMessage(
                waba._id, phoneNumberId, chat.waId, config.text
            );
            const msgId = waResult?.messages?.[0]?.id;
            await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'text', config.text);
            return { sent: true, messageId: msgId };
        }

        case 'send_template': {
            if (!config.templateName) return { skipped: true, reason: 'No template configured' };
            const waResult = await whatsappService.sendTemplateMessage(
                waba._id, phoneNumberId, chat.waId,
                config.templateName,
                config.language || 'en',
                config.components || []
            );
            const msgId = waResult?.messages?.[0]?.id;
            await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'template', `Template: ${config.templateName}`);
            return { sent: true, messageId: msgId };
        }

        case 'send_interactive': {
            const payload = {
                type: 'button',
                header: config.headerText ? { type: 'text', text: config.headerText } : undefined,
                body: { text: config.bodyText || '' },
                action: {
                    buttons: (config.buttons || []).map((btn, i) => ({
                        type: 'reply',
                        reply: { id: `btn_${i}`, title: btn.substring(0, 20) },
                    })),
                },
            };
            const waResult = await whatsappService.sendInteractiveMessage(
                waba._id, phoneNumberId, chat.waId, payload
            );
            const msgId = waResult?.messages?.[0]?.id;
            await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'interactive', config.bodyText || 'Interactive message', {
                interactiveType: 'button',
                headerText: config.headerText || '',
                bodyText: config.bodyText || '',
                buttons: config.buttons || [],
            });
            return { sent: true, messageId: msgId };
        }

        case 'send_interactive_list': {
            const listItems = (config.listItems || []).map((item, i) => ({
                id: `item_${i}`,
                title: item.substring(0, 24),
            }));
            const payload = {
                type: 'list',
                header: config.headerText ? { type: 'text', text: config.headerText } : undefined,
                body: { text: config.bodyText || '' },
                action: {
                    button: config.buttonText || 'View Options',
                    sections: [{
                        title: 'Options',
                        rows: listItems,
                    }],
                },
            };
            const waResult = await whatsappService.sendInteractiveMessage(
                waba._id, phoneNumberId, chat.waId, payload
            );
            const msgId = waResult?.messages?.[0]?.id;
            await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'interactive', config.bodyText || 'List message', {
                interactiveType: 'list',
                headerText: config.headerText || '',
                bodyText: config.bodyText || '',
                buttonText: config.buttonText || 'View Options',
                listItems: config.listItems || [],
            });
            return { sent: true, messageId: msgId };
        }

        case 'time_delay': {
            const duration = config.duration || 1;
            const unit = config.unit || 'seconds';
            let ms = duration * 1000;
            if (unit === 'minutes') ms = duration * 60 * 1000;
            else if (unit === 'hours') ms = duration * 60 * 60 * 1000;
            else if (unit === 'days') ms = duration * 24 * 60 * 60 * 1000;
            // Cap at 5 minutes for safety in sync execution
            ms = Math.min(ms, 5 * 60 * 1000);
            await new Promise(resolve => setTimeout(resolve, ms));
            return { waited: true, duration, unit };
        }

        case 'condition': {
            const field = config.field || '';
            const operator = config.operator || 'equals';
            const value = config.value || '';

            // Resolve the field value from context
            let fieldValue = '';
            if (field === 'message.text' || field === 'text') {
                fieldValue = text || '';
            } else if (field.startsWith('contact.')) {
                const contactField = field.replace('contact.', '');
                fieldValue = String(chat[contactField] || '');
            } else {
                fieldValue = text || '';
            }

            const matches = evaluateCondition(fieldValue, operator, value);
            return { branch: matches ? 'yes' : 'no', field, operator, value, fieldValue };
        }

        case 'assign_agent': {
            const method = config.assignMethod || 'auto';
            let agentId = null;

            if (method === 'specific' && config.agentId) {
                agentId = config.agentId;
            } else {
                // Auto round-robin
                const staffMembers = await User.find({
                    isActive: true,
                    role: 'staff',
                    assignedWabaId: waba._id,
                }).select('_id').lean();

                if (staffMembers.length > 0) {
                    const Chat = require('../models/Chat');
                    const chatCounts = await Promise.all(
                        staffMembers.map(async (staff) => {
                            const count = await Chat.countDocuments({
                                assignedTo: staff._id,
                                status: { $ne: 'closed' },
                            });
                            return { staffId: staff._id, count };
                        })
                    );
                    chatCounts.sort((a, b) => a.count - b.count);
                    agentId = chatCounts[0].staffId;
                }
            }

            if (agentId) {
                const Chat = require('../models/Chat');
                await Chat.findByIdAndUpdate(chat._id, { assignedTo: agentId });
                logger.info(`Bot assigned chat ${chat._id} to agent ${agentId}`);
            }
            return { assigned: true, agentId: agentId?.toString() };
        }

        case 'close_conversation': {
            const Chat = require('../models/Chat');
            await Chat.findByIdAndUpdate(chat._id, { status: 'closed' });
            logger.info(`Bot closed conversation ${chat._id}`);
            return { closed: true };
        }

        case 'opt_out': {
            const Contact = require('../models/Contact');
            if (chat.contactId) {
                await Contact.findByIdAndUpdate(chat.contactId, { optedOut: true });
            }
            return { optedOut: true };
        }

        case 'wait_till': {
            // For now, log it – real implementation would use a job scheduler
            logger.info(`Bot wait_till: ${config.datetime} (not waiting in sync mode)`);
            return { waitTill: config.datetime };
        }

        case 'working_hours_condition': {
            const now = new Date();
            const tz = config.timezone || 'Asia/Kolkata';
            // Get current time in the specified timezone
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                hour: 'numeric',
                minute: 'numeric',
                hour12: false,
            });
            const parts = formatter.formatToParts(now);
            const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
            const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
            const currentMinutes = hour * 60 + minute;

            const [startH, startM] = (config.startTime || '09:00').split(':').map(Number);
            const [endH, endM] = (config.endTime || '18:00').split(':').map(Number);
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;

            const withinHours = currentMinutes >= startMinutes && currentMinutes <= endMinutes;
            return { branch: withinHours ? 'yes' : 'no', withinHours, currentTime: `${hour}:${minute}` };
        }

        case 'set_attribute': {
            // Future implementation
            return { set: true, key: config.key, value: config.value };
        }

        default:
            logger.warn(`Unknown bot node type: ${node.type}`);
            return { skipped: true, reason: `Unknown type: ${node.type}` };
    }
}

/**
 * Evaluate a condition expression.
 */
function evaluateCondition(fieldValue, operator, value) {
    const fv = (fieldValue || '').toLowerCase();
    const v = (value || '').toLowerCase();
    switch (operator) {
        case 'equals': return fv === v;
        case 'not_equals': return fv !== v;
        case 'contains': return fv.includes(v);
        case 'not_contains': return !fv.includes(v);
        case 'starts_with': return fv.startsWith(v);
        case 'ends_with': return fv.endsWith(v);
        case 'is_empty': return !fv;
        case 'is_not_empty': return !!fv;
        default: return false;
    }
}

/**
 * Save an outbound message to the DB and emit socket event.
 */
async function saveOutboundMessage(chat, waba, phoneNumberId, msgId, type, text, metadata = null) {
    try {
        const resolvedType = type === 'template' ? 'template' : type === 'interactive' ? 'interactive' : type === 'image' ? 'image' : 'text';
        const outboundMsg = await Message.create({
            chatId: chat._id,
            wabaId: waba._id,
            phoneNumberId,
            messageId: msgId,
            waId: chat.waId,
            direction: 'outbound',
            type: resolvedType,
            text: resolvedType === 'image' ? undefined : text,
            caption: resolvedType === 'image' ? text : undefined,
            mediaUrl: metadata?.mediaUrl || undefined,
            status: 'sent',
            sentByBot: true,
            ...(metadata && { metadata }),
        });

        // Update chat
        const ChatModel = require('../models/Chat');
        await ChatModel.findByIdAndUpdate(chat._id, {
            lastMessageAt: new Date(),
            lastStaffMessageAt: new Date(),
        });

        // Emit socket event
        try {
            const { getIO } = require('../websocket/socket.server');
            const io = getIO();
            io.emit('message:new', { chatId: chat._id, message: outboundMsg });
        } catch (e) {
            logger.warn('Socket emit failed for bot message:', e.message);
        }

        return outboundMsg;
    } catch (err) {
        logger.error('Failed to save bot outbound message:', err.message);
    }
}

/**
 * Mark execution as finished.
 */
async function finishExecution(execution, status) {
    execution.status = status;
    execution.completedAt = new Date();
    await execution.save();
}

module.exports = {
    processIncomingMessage,
    processOpenConversation,
    processCloseConversation,
    processAgentAssign,
    evaluateTrigger,
};
