const path = require('path');
const fs = require('fs');
const { Product, ProductImport, Rate } = require('../models');

const GST = 0.03;

function calculatePrice(productData, rate) {
    const w = productData.weight;
    const cat = productData.category;
    if (!w || !cat || !rate) return undefined;

    if (cat === 'gold') {
        const karat = productData.carat;
        const ratePerGram = karat ? (rate.gold[karat] || 0) : 0;
        if (!ratePerGram) return undefined;
        const making = productData.makingCharge ? productData.makingCharge / 100 : 0;
        const extra = productData.extraCharge || 0;
        return Math.round((w * ratePerGram * (1 + making) + extra) * (1 + GST));
    }
    if (cat === 'silver') {
        if (!rate.silver) return undefined;
        const making = productData.makingCharge ? productData.makingCharge / 100 : 0;
        return Math.round(w * rate.silver * (1 + making) * (1 + GST));
    }
    if (cat === 'diamond') {
        if (!rate.diamond) return undefined;
        const extra = productData.extraCharge || 0;
        return Math.round((w * rate.diamond + extra) * (1 + GST));
    }
    return undefined;
}

async function list(req, res, next) {
    try {
        const { page = 1, limit = 20, category, isInStock, q, type } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (category) filter.category = category;
        if (isInStock !== undefined) filter.isInStock = isInStock === 'true';
        if (q) filter.$or = [
            { name: { $regex: q, $options: 'i' } },
            { code: { $regex: q, $options: 'i' } },
            { sku: { $regex: q, $options: 'i' } },
        ];

        const [data, total] = await Promise.all([
            Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit, 10)).lean(),
            Product.countDocuments(filter),
        ]);

        const rate = await Rate.findOne();
        if (rate) {
            data.forEach(p => {
                const computed = calculatePrice(p, rate);
                if (computed !== undefined) p.price = computed;
            });
        }

        res.json({ data, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function searchByCode(req, res, next) {
    try {
        const { code } = req.query;
        if (!code) return res.status(400).json({ success: false, message: 'code query param is required' });
        const products = await Product.find({ code: { $regex: code, $options: 'i' } }).limit(10).lean();

        const rate = await Rate.findOne();
        if (rate) {
            products.forEach(p => {
                const computed = calculatePrice(p, rate);
                if (computed !== undefined) p.price = computed;
            });
        }
        res.json(products);
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const product = await Product.findById(req.params.id).lean();
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

        const rate = await Rate.findOne();
        if (rate) {
            const computed = calculatePrice(product, rate);
            if (computed !== undefined) product.price = computed;
        }

        res.json(product);
    } catch (e) {
        next(e);
    }
}

async function create(req, res, next) {
    try {
        const productData = { ...req.body };
        const rate = await Rate.findOne();
        if (rate) {
            const computedPrice = calculatePrice(productData, rate);
            if (computedPrice !== undefined) productData.price = computedPrice;
        }

        const product = new Product(productData);
        await product.save();
        res.status(201).json(product);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {
    try {
        const productData = { ...req.body };

        // Fetch current product to safely compute price with merged data
        const currentProduct = await Product.findById(req.params.id);
        if (!currentProduct) return res.status(404).json({ success: false, message: 'Product not found' });

        const mergedData = { ...currentProduct.toObject(), ...productData };
        const rate = await Rate.findOne();
        if (rate) {
            const computedPrice = calculatePrice(mergedData, rate);
            if (computedPrice !== undefined) productData.price = computedPrice;
        }

        const product = await Product.findByIdAndUpdate(
            req.params.id,
            productData,
            { new: true, runValidators: true }
        );
        res.json(product);
    } catch (e) {
        next(e);
    }
}

async function remove(req, res, next) {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function bulkUpdateKarat(req, res, next) {
    try {
        const { codes, carat } = req.body;
        if (!codes || !Array.isArray(codes) || codes.length === 0) {
            return res.status(400).json({ success: false, message: 'codes array is required' });
        }
        if (carat === undefined || carat === null) {
            return res.status(400).json({ success: false, message: 'carat is required' });
        }
        const result = await Product.updateMany(
            { code: { $in: codes } },
            { $set: { carat: parseFloat(carat) } }
        );
        res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (e) {
        next(e);
    }
}

// Images functions removed.

async function listImports(req, res, next) {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (status) filter.status = status;

        const [imports, total] = await Promise.all([
            ProductImport.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .select('-importLog')
                .populate('importedBy', 'name phone'),
            ProductImport.countDocuments(filter),
        ]);
        res.json({ data: imports, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function getImport(req, res, next) {
    try {
        const imp = await ProductImport.findById(req.params.id)
            .select('-importLog')
            .populate('importedBy', 'name phone');
        if (!imp) return res.status(404).json({ success: false, message: 'Import not found' });
        res.json(imp);
    } catch (e) {
        next(e);
    }
}

async function getImportLogs(req, res, next) {
    try {
        const { page = 1, limit = 50, status } = req.query;
        const imp = await ProductImport.findById(req.params.id).select('importLog status fileName');
        if (!imp) return res.status(404).json({ success: false, message: 'Import not found' });

        let logs = imp.importLog || [];
        if (status) logs = logs.filter((l) => l.status === status);

        const total = logs.length;
        const start = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const paginated = logs.slice(start, start + parseInt(limit, 10));
        res.json({ data: paginated, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function importProducts(req, res, next) {
    try {
        const { category, mapping } = req.body;
        if (!category) return res.status(400).json({ success: false, message: 'category is required' });
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        let parsedMapping = {};
        try { parsedMapping = mapping ? JSON.parse(mapping) : {}; } catch (_) { }

        const productImport = await ProductImport.create({
            fileName: req.file.originalname,
            filePath: req.file.originalname, // memory storage — no real path
            category,
            status: 'queued',
            importedBy: req.user._id,
            mapping: parsedMapping,
        });

        // Buffer from memory storage
        const fileBuffer = req.file.buffer;

        // Process the import asynchronously
        setImmediate(async () => {
            try {
                await ProductImport.findByIdAndUpdate(productImport._id, { status: 'processing' });
                
                let dataLines = [];
                let headerLine = null;
                const isExcel = req.file.originalname.match(/\.(xlsx|xls)$/i) || 
                                req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                                req.file.mimetype === 'application/vnd.ms-excel';

                if (isExcel) {
                    const XLSX = require('xlsx');
                    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                    
                    if (jsonData.length > 0) {
                        headerLine = jsonData[0].map(h => String(h || '').trim().toLowerCase());
                        dataLines = jsonData.slice(1);
                    }
                } else {
                    const content = fileBuffer.toString('utf8');
                    const lines = content.split('\n').filter(l => l.trim());
                    const hasHeader = /[a-zA-Z]/.test(lines[0]?.split(',')[0]);
                    headerLine = hasHeader ? lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/"/g, '')) : null;
                    dataLines = hasHeader ? lines.slice(1) : lines;
                }

                const logs = [];
                let successCount = 0;
                let errorCount = 0;

                const rate = await Rate.findOne();

                for (let i = 0; i < dataLines.length; i++) {
                    const row = dataLines[i];
                    const cols = isExcel ? row : row.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
                    
                    try {
                        const getCol = (field) => {
                            if (parsedMapping[field] && headerLine) {
                                const idx = headerLine.indexOf(parsedMapping[field].toLowerCase());
                                return idx >= 0 ? cols[idx] : undefined;
                            }
                            // Default column order without type
                            const defaultOrder = { code: 0, name: 1, sku: 2, carat: 3, weight: 4, makingCharge: 5, extraCharge: 6, price: 7 };
                            return cols[defaultOrder[field]];
                        };

                        const code = getCol('code');
                        if (!code) throw new Error('Missing product code');

                        const productData = {
                            category,
                            code,
                            name: getCol('name') || undefined,
                            sku: getCol('sku') || undefined,
                            carat: getCol('carat') ? parseFloat(getCol('carat')) : undefined,
                            weight: getCol('weight') ? parseFloat(getCol('weight')) : undefined,
                            makingCharge: getCol('makingCharge') ? parseFloat(getCol('makingCharge')) : undefined,
                            extraCharge: getCol('extraCharge') ? parseFloat(getCol('extraCharge')) : undefined,
                            // Ignore price from file to favor system calculation
                            price: undefined, 
                        };

                        if (rate) {
                            const computedPrice = calculatePrice(productData, rate);
                            if (computedPrice !== undefined) productData.price = computedPrice;
                        }

                        // If still no price (e.g. rate not found), and the file HAS a price, 
                        // we still ignore it as per user requirement: "we will not import the price from it"
                        
                        await Product.findOneAndUpdate({ code }, productData, { upsert: true, new: true, runValidators: true });
                        logs.push({ rowNumber: i + 2, status: 'success', data: productData });
                        successCount++;
                    } catch (err) {
                        logs.push({ rowNumber: i + 2, status: 'error', error: err.message, data: cols });
                        errorCount++;
                    }
                }

                await ProductImport.findByIdAndUpdate(productImport._id, {
                    status: 'completed',
                    totalRows: dataLines.length,
                    successCount,
                    errorCount,
                    importLog: logs,
                    completedAt: new Date(),
                });
            } catch (err) {
                await ProductImport.findByIdAndUpdate(productImport._id, { status: 'failed' });
            }
        });

        res.status(202).json({ success: true, importId: productImport._id, message: 'Import queued for processing' });
    } catch (e) {
        next(e);
    }
}

module.exports = {
    list,
    searchByCode,
    get,
    create,
    update,
    remove,
    bulkUpdateKarat,
    listImports,
    getImport,
    getImportLogs,
    import: importProducts,
};
