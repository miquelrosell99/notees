# Phase 1 Security Migration Guide

This guide helps you upgrade existing Notees installations to the new secure configuration.

## Quick Migration Steps

### 1. Generate a SECRET_KEY

```bash
# Run the helper script
python scripts/generate_secret_key.py

# Or manually generate one
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

### 2. Update Your .env File

Add or update these variables in your `.env` file:

```bash
# REQUIRED - Replace with your generated key
SECRET_KEY=your-generated-secret-key-here

# OPTIONAL - Set admin password (or use the generated one from logs)
ADMIN_PASSWORD=your-secure-password

# REQUIRED for production - Set specific origins (no wildcards!)
CORS_ORIGINS=https://your-domain.com
```

### 3. Test Locally First

```bash
# Stop the application
docker-compose down

# Or if running directly:
# Ctrl+C to stop

# Start with new configuration
docker-compose up -d

# Check logs for any errors
docker-compose logs -f
```

### 4. Verify Security

✅ **Application starts successfully** - SECRET_KEY is valid  
✅ **Admin password shown in logs** (if not using ADMIN_PASSWORD env var)  
✅ **No CORS wildcard warnings** - Specific origins configured  
✅ **Asset loading works** - Images/audio display correctly  

## Breaking Changes

### SECRET_KEY is Now Required

**Before:** Used a default insecure key  
**After:** Application will not start without a valid SECRET_KEY

**Action Required:** Set SECRET_KEY in .env file

### CORS Default Changed

**Before:** Allowed all origins (`*`)  
**After:** No origins allowed by default

**Action Required:** Set CORS_ORIGINS to your frontend URL(s)

### Admin Password Changed

**Before:** Always created with password "admin"  
**After:** Generates secure random password or uses ADMIN_PASSWORD env var

**Action Required:** 
- Either set ADMIN_PASSWORD before first run
- Or save the generated password from logs

### Asset URLs No Longer Use JWT Tokens

**Before:** `src="/api/assets/{uuid}?token={jwt}"`  
**After:** `src="/api/assets/{uuid}"` (uses Authorization header)

**Action Required:** None - handled automatically by frontend

**Note:** Old `token` parameter still supported during migration period

## Troubleshooting

### Application Won't Start

**Error:** "SECRET_KEY environment variable must be set"

**Solution:** Add SECRET_KEY to your .env file (see step 1)

---

**Error:** "SECRET_KEY must be at least 32 characters long"

**Solution:** Generate a new key using the script (see step 1)

### CORS Errors in Browser Console

**Error:** "Access-Control-Allow-Origin" errors

**Solution:** Add your frontend URL to CORS_ORIGINS in .env:
```bash
CORS_ORIGINS=http://localhost:5173,https://your-domain.com
```

### Cannot Login

**Issue:** Don't know admin password

**Solution:** 
1. If using existing database: Password hasn't changed (still your old password)
2. If fresh install: Check application logs for generated password
3. Set ADMIN_PASSWORD env var and restart

### Assets Not Loading

**Error:** 401 Unauthorized on asset requests

**Solution:** 
- Check that you're logged in
- Verify Authorization header is being sent (check browser Network tab)
- Try clearing browser cache and localStorage

## Rollback (If Needed)

If you need to temporarily rollback:

```bash
# Checkout previous commit
git checkout HEAD~1

# Or manually revert the changes in:
# - app/config.py (set secret_key default)
# - app/auth.py (restore ensure_admin_user)
# - .env (remove SECRET_KEY requirement)

# Restart application
docker-compose restart
```

**Note:** This is NOT recommended for production - fix configuration issues instead.

## Post-Migration Checklist

After migration, verify:

- [ ] Application starts without errors
- [ ] Can login with admin credentials
- [ ] Pages load correctly
- [ ] Images and audio files display
- [ ] No CORS errors in browser console
- [ ] SECRET_KEY is at least 32 characters
- [ ] CORS_ORIGINS is set to specific domains (not `*`)
- [ ] Admin password is saved securely

## Support

If you encounter issues not covered here, please:

1. Check application logs: `docker-compose logs -f`
2. Review the [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) Phase 1 section
3. Open an issue on GitHub with:
   - Error messages from logs
   - Your .env configuration (without secrets!)
   - Steps to reproduce the issue
