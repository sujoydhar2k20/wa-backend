require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { connectDB } = require('../src/config/database');

async function createSuperAdmin() {
  const args = process.argv.slice(2);
  const phoneInput = args[0];
  const name = args[1] || 'Super Admin';

  if (!phoneInput) {
    console.error('Usage: node create-superadmin.js <phone_number> [name]');
    console.error('Example: node create-superadmin.js +919876543210 "Admin User"');
    process.exit(1);
  }

  const phone = phoneInput.replace(/\D/g, '');

  try {
    await connectDB();
    
    const user = await User.findOneAndUpdate(
      { phone },
      { 
        phone, 
        name, 
        role: 'superadmin',
        isActive: true 
      },
      { upsert: true, new: true }
    );

    console.log('------------------------------------------');
    console.log('Super Admin User Created/Updated Successfully!');
    console.log('------------------------------------------');
    console.log(`Name:  ${user.name}`);
    console.log(`Phone: ${user.phone}`);
    console.log(`Role:  ${user.role}`);
    console.log('------------------------------------------');
    console.log('This user can now login using the normal OTP flow.');
    console.log('The system will detect the superadmin role upon login.');
    
    await mongoose.connection.close();
  } catch (err) {
    console.error('Error creating Super Admin:', err.message);
    process.exit(1);
  }
}

createSuperAdmin();
