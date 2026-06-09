/**
 * Bot Execution Service
 * 
 * Processes incoming messages against enabled bot flows.
 * When a trigger matches, executes action nodes in sequence.
 */

const { BotFlow, BotExecution, Chat, User, Message, Contact } = require('../models');
const whatsappService = require('./whatsapp.service');
const { logger } = require('../utils/logger');

/**
 * Main entry: evaluate all enabled bot flows against incoming message context.
 * Called from webhook.service.js after a message is saved.
 */
async function processIncomingMessage({ waba, phoneNumberId, chat, message, text, isNewChat }) {
    try {
        // Check for active running execution for this chat
        const activeExecution = await BotExecution.findOne({
            chatId: chat._id,
            status: 'running',
            currentNodeId: { $ne: null }
        });

        if (activeExecution) {
            const flow = await BotFlow.findById(activeExecution.flowId).lean();
            if (flow && flow.isEnabled) {
                const nodeMap = {};
                for (const node of (flow.nodes || [])) {
                    nodeMap[node.id] = node;
                }
                const currentNode = nodeMap[activeExecution.currentNodeId];

                if (currentNode && (currentNode.type === 'send_interactive' || currentNode.type === 'send_interactive_list')) {
                    let replyId = null;

                    // Get reply ID from message metadata (button_reply or list_reply)
                    if (message?.metadata?.button_reply) {
                        replyId = message.metadata.button_reply.id;
                    } else if (message?.metadata?.list_reply) {
                        replyId = message.metadata.list_reply.id;
                    }

                    // Fallback to text matching
                    if (!replyId && text) {
                        const lowerText = text.toLowerCase().trim();
                        if (currentNode.type === 'send_interactive') {
                            const buttons = currentNode.config?.buttons || [];
                            const btnIdx = buttons.findIndex(btn => btn.toLowerCase().trim() === lowerText);
                            if (btnIdx !== -1) {
                                replyId = `btn_${btnIdx}`;
                            }
                        } else if (currentNode.type === 'send_interactive_list') {
                            const listItems = currentNode.config?.listItems || [];
                            const itemIdx = listItems.findIndex(item => item.toLowerCase().trim() === lowerText);
                            if (itemIdx !== -1) {
                                replyId = `item_${itemIdx}`;
                            }
                        }
                    }

                    if (replyId) {
                        logger.info(`Resuming bot flow "${flow.name}" from node ${currentNode.id} on button/item reply "${replyId}"`);
                        resumeFlow(flow, activeExecution, replyId, { waba, phoneNumberId, chat, message, text })
                            .catch(err => logger.error(`Bot flow resume error for "${flow.name}":`, err.message));
                        return; // Resumed successfully, stop processing further flows
                    } else {
                        // Customer sent something else: stop current flow execution so we don't lock future executions
                        activeExecution.status = 'stopped';
                        activeExecution.completedAt = new Date();
                        await activeExecution.save();
                        logger.info(`Terminated active flow "${flow.name}" because customer sent a non-button reply: "${text}"`);
                    }
                }
            }
        }

        // Fetch all enabled flows
        const flows = await BotFlow.find({ isEnabled: true }).lean();
        if (!flows.length) return;

        for (const flow of flows) {
            const triggerResult = evaluateTrigger(flow.trigger, { chat, message, text, isNewChat });
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
function evaluateTrigger(trigger, { chat, message, text, isNewChat }) {
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
            return { matched: !!isNewChat };
        }
        case 'on_open_conversation':
        case 'on_close_conversation':
        case 'on_agent_assign':
            return { matched: false }; // These are event-based, not triggered by incoming customer messages
        default:
            return { matched: false };
    }
}

/**
 * Resolves template variables in the message text.
 * Supported variables:
 * - {{agent_name}}, {{staff_name}}, {{agent.name}}: Assigned agent's name (fallback: "our representative")
 * - {{contact_name}}, {{contact.name}}, {{customer_name}}: Customer's name (fallback: chat.name or contact's name)
 */
async function resolveMessageTemplate(textTemplate, chat) {
    if (!textTemplate) return '';
    let resolvedText = textTemplate;

    // Fetch assigned agent name if present
    let agentName = 'our representative';
    if (chat.assignedTo) {
        try {
            const agentId = chat.assignedTo._id || chat.assignedTo;
            const agent = await User.findById(agentId).select('name').lean();
            if (agent && agent.name) {
                agentName = agent.name;
            }
        } catch (err) {
            logger.error('Error fetching agent for template resolution:', err.message);
        }
    }

    // Fetch customer/contact name if present
    let contactName = chat.name || '';
    if (chat.contactId) {
        try {
            const contactId = chat.contactId._id || chat.contactId;
            const contact = await Contact.findById(contactId).select('name nameOnWhatsApp').lean();
            if (contact) {
                contactName = contact.name || contact.nameOnWhatsApp || '';
            }
        } catch (err) {
            logger.error('Error fetching contact for template resolution:', err.message);
        }
    }

    // Replace variables
    resolvedText = resolvedText.replace(/\{\{(agent_name|staff_name|agent\.name)\}\}/g, agentName);
    resolvedText = resolvedText.replace(/\{\{(contact_name|contact\.name|customer_name)\}\}/g, contactName);

    return resolvedText;
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
        let isPaused = false;

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

                    // If interactive node, pause execution at this node
                    if (node.type === 'send_interactive' || node.type === 'send_interactive_list') {
                        isPaused = true;
                        execution.status = 'running';
                        execution.currentNodeId = node.id;
                        await execution.save();
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

        if (!isPaused) {
            await finishExecution(execution, 'completed');
            logger.info(`Bot flow "${flow.name}" completed for chat ${chat._id}`);
        } else {
            logger.info(`Bot flow "${flow.name}" paused at node ${execution.currentNodeId} for chat ${chat._id}`);
        }

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
 * Resume execution of a paused bot flow from a specific button or item reply edge.
 */
async function resumeFlow(flow, execution, replyId, context) {
    const { waba, phoneNumberId, chat, message, text } = context;
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

    try {
        const currentNodeId = execution.currentNodeId;
        const edges = edgeMap[currentNodeId] || [];
        
        // Find the edge originating from the interactive node that matches the button/item ID
        const matchedEdge = edges.find(e => e.sourceHandle === replyId);
        
        if (!matchedEdge) {
            logger.warn(`No edge found matching sourceHandle ${replyId} on node ${currentNodeId} in flow ${flow.name}`);
            await finishExecution(execution, 'completed');
            return;
        }

        // Start walking from the target node of the matched edge
        const visited = new Set();
        let totalSteps = 0;
        const maxSteps = 50;
        let isPaused = false;

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

            // Execute node action
            try {
                const result = await executeNode(node, { waba, phoneNumberId, chat, message, text, flow });
                execution.executionLog.push({
                    nodeId: node.id,
                    action: node.type,
                    result: result,
                    timestamp: new Date(),
                });
                execution.currentNodeId = node.id;

                if (node.type === 'condition' || node.type === 'working_hours_condition') {
                    const nodeEdges = edgeMap[nodeId] || [];
                    const branch = result?.branch || 'yes';
                    const matchedNodeEdge = nodeEdges.find(e => e.sourceHandle === branch) || nodeEdges[0];
                    if (matchedNodeEdge) {
                        await walkNode(matchedNodeEdge.target);
                    }
                    return;
                }

                if (node.type === 'send_interactive' || node.type === 'send_interactive_list') {
                    isPaused = true;
                    execution.status = 'running';
                    execution.currentNodeId = node.id;
                    await execution.save();
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
            }

            // Follow ALL edges from this node
            const nodeEdges = edgeMap[nodeId] || [];
            for (const edge of nodeEdges) {
                await walkNode(edge.target);
            }
        }

        // Run from the matched edge's target
        await walkNode(matchedEdge.target);

        if (!isPaused) {
            await finishExecution(execution, 'completed');
            logger.info(`Bot flow "${flow.name}" completed for chat ${chat._id}`);
        } else {
            logger.info(`Bot flow "${flow.name}" paused at node ${execution.currentNodeId} for chat ${chat._id}`);
        }

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

            const resolvedText = await resolveMessageTemplate(config.text || '', chat);

            // If an image URL is provided, send as media message
            if (config.imageUrl) {
                const waResult = await whatsappService.sendMediaMessage(
                    waba._id, phoneNumberId, chat.waId, 'image', config.imageUrl, resolvedText
                );
                const msgId = waResult?.messages?.[0]?.id;
                await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'image', resolvedText, {
                    mediaUrl: config.imageUrl,
                });
                return { sent: true, messageId: msgId, type: 'image' };
            }

            // Plain text message
            const waResult = await whatsappService.sendTextMessage(
                waba._id, phoneNumberId, chat.waId, resolvedText
            );
            const msgId = waResult?.messages?.[0]?.id;
            await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'text', resolvedText);
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
            const resolvedHeader = config.headerText ? await resolveMessageTemplate(config.headerText, chat) : undefined;
            const resolvedBody = await resolveMessageTemplate(config.bodyText || '', chat);

            const payload = {
                type: 'button',
                header: resolvedHeader ? { type: 'text', text: resolvedHeader } : undefined,
                body: { text: resolvedBody },
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
            await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'interactive', resolvedBody || 'Interactive message', {
                interactiveType: 'button',
                headerText: resolvedHeader || '',
                bodyText: resolvedBody || '',
                buttons: config.buttons || [],
            });
            return { sent: true, messageId: msgId };
        }

        case 'send_interactive_list': {
            const resolvedHeader = config.headerText ? await resolveMessageTemplate(config.headerText, chat) : undefined;
            const resolvedBody = await resolveMessageTemplate(config.bodyText || '', chat);
            const resolvedButton = config.buttonText ? await resolveMessageTemplate(config.buttonText, chat) : 'View Options';

            const listItems = (config.listItems || []).map((item, i) => ({
                id: `item_${i}`,
                title: item.substring(0, 24),
            }));
            const payload = {
                type: 'list',
                header: resolvedHeader ? { type: 'text', text: resolvedHeader } : undefined,
                body: { text: resolvedBody },
                action: {
                    button: resolvedButton.substring(0, 20),
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
            await saveOutboundMessage(chat, waba, phoneNumberId, msgId, 'interactive', resolvedBody || 'List message', {
                interactiveType: 'list',
                headerText: resolvedHeader || '',
                bodyText: resolvedBody || '',
                buttonText: resolvedButton || 'View Options',
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
                    const ChatModel = require('../models/Chat');
                    const chatCounts = await Promise.all(
                        staffMembers.map(async (staff) => {
                            const count = await ChatModel.countDocuments({
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
                const ChatModel = require('../models/Chat');
                await ChatModel.findByIdAndUpdate(chat._id, { assignedTo: agentId });
                chat.assignedTo = agentId; // Update in-memory reference for subsequent nodes

                logger.info(`Bot assigned chat ${chat._id} to agent ${agentId}`);

                // Emit socket event to update the frontend in real-time
                try {
                    const populatedChat = await ChatModel.findById(chat._id)
                        .populate('contactId', 'name nickname profilePicture isOptedOut isBlocked customFields')
                        .populate('assignedTo', 'name phone')
                        .populate('wabaId', 'businessName phoneNumbers')
                        .populate('collaborators', 'name phone')
                        .populate('tags', 'name color')
                        .lean();

                    const { getIO } = require('../websocket/socket.server');
                    const io = getIO();
                    io.emit('chat:update', {
                        chatId: chat._id.toString(),
                        chat: populatedChat
                    });
                } catch (e) {
                    logger.warn('Socket emit failed for bot agent assign:', e.message);
                }
            }
            return { assigned: true, agentId: agentId?.toString() };
        }

        case 'close_conversation': {
            const ChatModel = require('../models/Chat');
            const closedAt = new Date();
            await ChatModel.findByIdAndUpdate(chat._id, { status: 'closed', closedAt });
            
            const populatedChat = await ChatModel.findById(chat._id)
                .populate('contactId')
                .populate('assignedTo', 'name phone')
                .populate('wabaId', 'businessName phoneNumbers')
                .populate('tags', 'name color')
                .lean();

            try {
                const { getIO } = require('../websocket/socket.server');
                const io = getIO();
                io.emit('chat:update', { 
                    chatId: chat._id.toString(), 
                    chat: populatedChat 
                });
            } catch (e) {
                logger.warn('Socket emit failed for bot close:', e.message);
            }
            logger.info(`Bot closed conversation ${chat._id}`);
            return { closed: true };
        }

        case 'opt_out': {
            const Contact = require('../models/Contact');
            const ChatModel = require('../models/Chat');
            if (chat.contactId) {
                await Contact.findByIdAndUpdate(chat.contactId, { 
                    isOptedOut: true,
                    optedOutAt: new Date()
                });
            }
            
            // Close the chat conversation as well
            const closedAt = new Date();
            await ChatModel.findByIdAndUpdate(chat._id, { status: 'closed', closedAt });

            const populatedChat = await ChatModel.findById(chat._id)
                .populate('contactId')
                .populate('assignedTo', 'name phone')
                .populate('wabaId', 'businessName phoneNumbers')
                .populate('tags', 'name color')
                .lean();

            try {
                const { getIO } = require('../websocket/socket.server');
                const io = getIO();
                io.emit('chat:update', { 
                    chatId: chat._id.toString(), 
                    chat: populatedChat 
                });
            } catch (e) {
                logger.warn('Socket emit failed for bot opt-out:', e.message);
            }

            logger.info(`Bot opted out contact ${chat.contactId} and closed conversation ${chat._id}`);
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

            // Get current day of the week in target timezone
            const dayFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                weekday: 'long',
            });
            const currentDay = dayFormatter.format(now).toLowerCase();

            // Validate day matches selected working days
            let dayMatches = true;
            if (config.workingDays && config.workingDays.length > 0) {
                const workingDays = config.workingDays.map(d => String(d).toLowerCase().trim());
                dayMatches = workingDays.includes(currentDay);
            }

            const [startH, startM] = (config.startTime || '09:00').split(':').map(Number);
            const [endH, endM] = (config.endTime || '18:00').split(':').map(Number);
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;

            const timeMatches = currentMinutes >= startMinutes && currentMinutes <= endMinutes;
            const withinHours = dayMatches && timeMatches;
            return { branch: withinHours ? 'yes' : 'no', withinHours, currentTime: `${hour}:${minute}`, currentDay };
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
