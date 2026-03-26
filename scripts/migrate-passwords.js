/**
 * SCRIPT DE MIGRACIÓN: Convertir contraseñas en texto plano a bcrypt
 * 
 * Uso: node scripts/migrate-passwords.js
 * 
 * ⚠️ ESTE SCRIPT SOLO SE EJECUTA UNA VEZ
 * Una vez ejecutado, todas las contraseñas serán encriptadas con bcrypt
 */

const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function migratePasswords() {
  try {
    console.log('🔄 Iniciando migración de contraseñas...\n');

    // Obtener todos los usuarios con contraseñas sin hash
    const [users] = await db.query(`
      SELECT id, username, password FROM users 
      WHERE password NOT LIKE '$2b$%'
    `);

    if (users.length === 0) {
      console.log('✓ Todas las contraseñas ya están hashadas. No hay nada que migrar.');
      process.exit(0);
    }

    console.log(`📊 Encontrados ${users.length} usuarios con contraseñas sin hash\n`);

    let migratedCount = 0;

    for (const user of users) {
      try {
        // Hashear la contraseña
        const hashedPassword = await bcrypt.hash(user.password, 10);

        // Actualizar en la BD
        await db.query(
          'UPDATE users SET password = ? WHERE id = ?',
          [hashedPassword, user.id]
        );

        console.log(`✓ Migrado: ${user.username}`);
        migratedCount++;
      } catch (error) {
        console.error(`✗ Error migrando ${user.username}:`, error.message);
      }
    }

    console.log(`\n✅ Migración completada: ${migratedCount}/${users.length} usuarios actualizados`);

    // Verificar que las contraseñas fue migren correctamente
    const [verifyUsers] = await db.query(`
      SELECT COUNT(*) as total FROM users 
      WHERE password LIKE '$2b$%'
    `);

    console.log(`\n🔐 Verificación: ${verifyUsers[0].total} contraseñas están hashadas con bcrypt`);
    console.log('\n✨ ¡La migración fue exitosa!');

  } catch (error) {
    console.error('❌ Error durante la migración:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Ejecutar migración
migratePasswords();
