# Connecting Storybook to the Figma Plugin

To connect your Storybook instance to the Figma plugin, you must configure your Storybook server to allow cross-origin requests from Figma. This guide explains why this is necessary and provides solutions for different hosting environments.

## Why is CORS configuration required?

Figma plugins operate within a sandboxed `iframe`, which has a unique `origin` of `null`. When the plugin attempts to fetch data from your Storybook server (e.g., to get the `index.json` file), the browser's security policies will block the request unless your server explicitly permits it.

This is a security feature known as Cross-Origin Resource Sharing (CORS). To resolve this, you must add the `Access-Control-Allow-Origin` header to your Storybook server's HTTP responses.

### Common Error Message

If CORS is not configured correctly, you will see an error in your browser's developer console similar to this:

```
Access to fetch at 'http://localhost:6006/index.json' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

## Solutions

The solution depends on whether you are running Storybook locally for development or using a hosted production build.

### 1. Local Development (Storybook Dev Server)

If you are using Storybook's local development server, you can enable CORS directly in your Storybook configuration.

**For Vite-based Storybook:**

In `.storybook/main.ts` (or `.js`), add the `cors: true` option to the `viteFinal` configuration:

```typescript
// .storybook/main.ts
import { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  // ... other config
  async viteFinal(config) {
    // Enable CORS
    config.server = {
      ...config.server,
      cors: true,
    };
    return config;
  },
};

export default config;
```

### 2. Hosted/Production Storybook

For a deployed Storybook site, CORS headers must be configured at the hosting or CDN layer. Below are examples for common hosting providers.

#### Vercel

Create or update the `vercel.json` file in your project's root directory with a `headers` section:

```json
// vercel.json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" },
        { "key": "Access-Control-Allow-Methods", "value": "GET, HEAD, OPTIONS" },
        { "key": "Access-Control-Allow-Headers", "value": "Content-Type" }
      ]
    }
  ]
}
```

#### Netlify

Create a `_headers` file in your Storybook's public directory (e.g., `public/` or `storybook-static/`):

```
# public/_headers
/*
  Access-Control-Allow-Origin: *
```

#### AWS S3 + CloudFront

If you host your Storybook on an S3 bucket, you need to configure a CORS policy on the bucket itself.

1.  Navigate to your S3 bucket in the AWS Console.
2.  Go to the **Permissions** tab.
3.  Scroll down to **Cross-origin resource sharing (CORS)** and click **Edit**.
4.  Add the following JSON configuration:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": []
  }
]
```
**Note:** For CloudFront distributions, ensure that the cache policy forwards the `Origin` header.

#### Nginx

If you are serving your Storybook build from a self-hosted Nginx server, add the following directive to your server block configuration:

```nginx
# /etc/nginx/sites-available/your-storybook.conf
server {
  # ... other config

  location / {
    # Add CORS header to all responses
    add_header Access-Control-Allow-Origin '*' always;

    # ... other directives
  }
}
```

### Supported Hosting Platforms

-   **Chromatic**: Includes the necessary CORS headers by default. No additional configuration is needed.

## Alternative: Using a CORS Proxy

If you cannot modify the CORS headers of your Storybook instance (e.g., due to security policies or lack of access), you can use a proxy server. The proxy will fetch the Storybook assets on your behalf and add the required CORS headers to the response.

Our service provides a proxy endpoint for this purpose. To use it, simply prefix your Storybook URL with our proxy URL when connecting from the Figma plugin.
