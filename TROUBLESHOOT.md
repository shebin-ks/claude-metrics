# Troubleshooting - Loading Issues

If the dashboard keeps loading with no data, follow these steps:

---

## 🔍 **Step 1: Check Browser Console**

1. Open browser developer tools: **F12** or **Cmd+Shift+I**
2. Go to **Console** tab
3. Look for error messages in red
4. Copy any error and check below

---

## 🔍 **Step 2: Check Terminal/Server Logs**

1. Look at the terminal where you ran `npm run github`
2. You should see logs like:
   ```
   🔄 Starting data collection...
   ⏳ Fetching profile...
   ✅ Data collection complete!
   ```

If you see **❌ Error**, check the message.

---

## 🐛 **Common Issues & Fixes**

### **Issue 1: Token Invalid**
```
❌ Error: Invalid token
```
**Fix:**
- Check your `.env` file has correct token
- Token should start with `ghp_`
- Make sure no extra spaces: `GITHUB_TOKEN=ghp_xxx` (no spaces)

### **Issue 2: GitHub API Rate Limited**
```
❌ Error: API rate limit exceeded
```
**Fix:**
- Wait 1 hour, or
- Get a fresh token with higher rate limit
- Use different GitHub account

### **Issue 3: Timeout (Took Too Long)**
```
❌ Error: Timeout (took too long)
```
**Fix:**
- Your GitHub has too many repos/commits
- Try again - sometimes network is slow
- Or use smaller GitHub account for testing

### **Issue 4: Network Error**
```
❌ Failed to fetch
```
**Fix:**
- Check internet connection
- Make sure server is running (`npm run github`)
- Try: `curl http://localhost:3001/health`

### **Issue 5: No .env Token**
```
No data collected yet
```
**Fix:**
- Add token to `.env`:
  ```
  GITHUB_TOKEN=ghp_your_token_here
  ```
- Restart server: `npm run github`

---

## 🧪 **Test the Server**

### **Check if server is running:**
```bash
curl http://localhost:3001/health
# Should return: {"status":"OK"}
```

### **Manually fetch data:**
```bash
curl -X POST http://localhost:3001/api/fetch-latest \
  -H "Content-Type: application/json" \
  -d '{"token":"ghp_your_token"}'
```

### **Check available data:**
```bash
curl http://localhost:3001/api/available
# Should show users and their data types
```

---

## 📋 **Step-by-Step Debug**

1. **Verify token:**
   ```bash
   cat .env | grep GITHUB_TOKEN
   ```
   Should show: `GITHUB_TOKEN=ghp_xxxxx`

2. **Check server logs:**
   ```bash
   # In terminal running npm run github, look for:
   # ✅ Authenticated as: username
   # 📊 Fetching profile...
   ```

3. **Check browser console:**
   - Open F12 → Console tab
   - Look for JavaScript errors
   - Check network tab for failed requests

4. **Test with manual token:**
   - Click "Fetch Latest" button
   - Paste token manually instead of using .env
   - See if that works

---

## ⏱️ **Expected Timing**

- **Small account** (< 100 repos): 1-2 minutes
- **Medium account** (100-500 repos): 2-5 minutes  
- **Large account** (500+ repos): 5-10 minutes

If it's taking longer, it might be timeout or network issue.

---

## 📞 **Still Not Working?**

Check these files exist:
```bash
ls -la github-server.js
ls -la .env
ls -la package.json
```

All three should be in the `claude_metrics/` directory.

---

## 🔄 **Nuclear Option - Start Fresh**

```bash
# 1. Delete cached data
rm -rf github-data-store/

# 2. Restart server
npm run github

# 3. Click fetch button or wait for auto-fetch
```

---

## 💡 **Pro Tips**

- **Add verbose logging:** Run `NODE_DEBUG=fetch npm run github` to see all requests
- **Test with small repo:** Use GitHub account with just 1-2 repos first
- **Check rate limit:** Visit https://api.github.com/rate_limit in browser (with token)
- **Use different token:** Try a new token from Settings → Developer Settings → Personal access tokens

---

**Still stuck? Check the console errors above!** 🎯
