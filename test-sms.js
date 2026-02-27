require('dotenv').config();
const axios = require('axios');

const BHS_USER = process.env.BHASHSMS_USER || '7278665321';
const BHS_PASS = process.env.BHASHSMS_PASS || 'a485bc9';
const BHS_SENDER = process.env.BHASHSMS_SENDER || 'BJSBIL';

async function sendOtp(phone, otp) {
    let targetPhone = phone;
    if (targetPhone.length === 10) {
        targetPhone = `91${targetPhone}`;
    } else if (targetPhone.startsWith('+')) {
        targetPhone = targetPhone.substring(1);
    }

    const text = `Your OTP is ${otp}`;
    const url = `https://bhashsms.com/api/sendmsg.php?user=${BHS_USER}&pass=${BHS_PASS}&sender=${BHS_SENDER}&phone=${encodeURIComponent(targetPhone)}&text=${encodeURIComponent(text)}&priority=dnd&stype=normal`;

    console.log(`Sending to URL: ${url}`);
    try {
        const response = await axios.get(url);
        console.log('Response status:', response.status);
        console.log('Response data:', response.data);
    } catch (err) {
        console.error('BhashSMS send failed:', err.message);
        if (err.response) {
            console.error('Response data:', err.response.data);
        }
    }
}

const testPhone = '+918968369582';
const testOtp = '123456';
console.log(`Testing SMS dispatch to ${testPhone} with OTP ${testOtp}`);
sendOtp(testPhone, testOtp);
