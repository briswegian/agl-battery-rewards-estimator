# AGL Battery Rewards Estimator

A Tampermonkey user script designed for AGL customers (specifically those on Battery Rewards Plan) to get a clear estimate of their electricity costs and FiT credits directly on the AGL MyAccount usage page.

## Introduction

The AGL MyAccount dashboard provides raw usage data but often lacks a dynamic summary that includes daily supply charges, gift card incentives, and end-of-quarter forecasts. This script parses the existing usage elements and overlays a premium, high-contrast panel that calculates your net financial position (Credit or Owning).

## Features

- **⚡ Calculation**: Automatically sums up electricity bought vs. feed-in.
- **📊 Supply Charge Integration**: Factors in the daily supply charge based on the current billing period.
- **🎁 Gift Card Tiers**: Automatically calculates your eligible gift card reward based on solar export kWh.
- **📈 Quarter Forecast**: Provides a linear projection of your end-of-bill costs and revenues.
- **🌗 Dark Mode UI**: A sleek, modern floating panel that matches a premium aesthetic.
- **📋 Tariff Reference**: A built-in, collapsible reference for your specific plan rates (TOU & CL31).

## How to Install

1. **Install Tampermonkey**: If you haven't already, install the [Tampermonkey extension](https://www.tampermonkey.net/) for your browser (Chrome, Firefox, Edge, etc.).
2. **Create New Script**:
   - Click the Tampermonkey icon in your browser and select **"Create a new script..."**.
   - Delete any default code in the editor.
3. **Copy and Paste**:
   - Open the `AGL Battery Rewards Estimator.user.js` file from this repository.
   - Copy the entire content and paste it into the Tampermonkey editor.
4. **Save**: Press `Ctrl+S` (or `Cmd+S` on Mac) or go to **File > Save** in the Tampermonkey editor.

## How to Use

1. Log in to your [AGL MyAccount](https://myaccount.agl.com.au/).
2. Navigate to the **Usage** section where the bar charts are displayed.
3. The script will wait for the page to load and then display the **⚡ AGL Battery Rewards Estimator** panel in the bottom-right corner.

## Customization

The script uses specific tariff rates and gift card tiers. If your plan differs (e.g., different supply charge or feed-in rate), you can easily update the constants at the top of the script:

```javascript
// Update these values in the script source:
const SUPPLY_CHARGE_CENTS_PER_DAY = 160.655;
const PEAK_RATE_CENTS_PER_KWH = 50.38;
const SHOULDER_RATE_CENTS_PER_KWH = 19.998;
const OFFPEAK_RATE_CENTS_PER_KWH = 19.998;
const CL31_RATE_CENTS_PER_KWH = 17.666;
const SOLAR_FIT_CENTS_PER_KWH = 3;
const GIFT_CARD_TIERS = [ ... ];
```

## Disclaimer

*This script is a third-party tool and is not affiliated with, authorized, or endorsed by AGL Energy. All calculations are estimates based on scraped DOM data and may not perfectly match your final bill due to taxes, rounding, or mid-cycle rate changes.*
