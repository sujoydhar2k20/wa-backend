const axios = require('axios');

exports.getCategoriesTree = async (req, res) => {
    try {
        const response = await axios.get('https://client.biswakarmagold.com/api/categories/tree');
        res.json(response.data);
    } catch (error) {
        console.error('Error in getCategoriesTree proxy:', error.message);
        res.status(error.response?.status || 500).json({
            message: 'Failed to fetch categories tree',
            error: error.message
        });
    }
};

exports.getProductsList = async (req, res) => {
    try {
        const response = await axios.get('https://client.biswakarmagold.com/api/products/list', {
            params: req.query
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error in getProductsList proxy:', error.message);
        res.status(error.response?.status || 500).json({
            message: 'Failed to fetch products list',
            error: error.message
        });
    }
};
