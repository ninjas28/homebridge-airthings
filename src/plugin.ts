import { AirthingsApi, AirthingsApiDeviceSample } from "./api";
import { AirthingsDevice, AirthingsDeviceInfo } from "./device";
import { Mutex } from "async-mutex";
import { AccessoryConfig, AccessoryPlugin, API, Logging, Service } from "homebridge";

export = (api: API) => {
  api.registerAccessory("Airthings", AirthingsPlugin);
};

class AirthingsPlugin implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly mutex: Mutex;

  private readonly airthingsApi: AirthingsApi;
  private readonly airthingsConfig: AirthingsPluginConfig;
  private readonly airthingsDevice: AirthingsDeviceInfo;

  private readonly informationService: Service;
  private readonly batteryService: Service;
  private readonly airQualityService: Service;
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private readonly carbonDioxideService: Service;
  private readonly airPressureService: Service;

  private latestSamples: AirthingsApiDeviceSample = {
    data: {}
  };
  private latestSamplesTimestamp: number = 0;

  constructor(log: Logging, config: AirthingsPluginConfig, api: API) {
    if (config.clientId == null) {
      log.error("Missing required config value: clientId");
    }

    if (config.clientSecret == null) {
      log.error("Missing required config value: clientSecret");
    }

    if (config.serialNumber == null) {
      log.error("Missing required config value: serialNumber");
      config.serialNumber = "0000000000";
    }

    this.log = log;
    this.mutex = new Mutex();

    this.airthingsApi = new AirthingsApi(config.clientId, config.clientSecret);
    this.airthingsConfig = config;
    this.airthingsDevice = AirthingsDevice.getDevice(config.serialNumber);

    this.log.info(`Device Model: ${this.airthingsDevice.model}`);
    this.log.info(`Serial Number: ${config.serialNumber}`);

    // HomeKit Information Service
    this.informationService = new api.hap.Service.AccessoryInformation()
      .setCharacteristic(api.hap.Characteristic.Manufacturer, "Airthings")
      .setCharacteristic(api.hap.Characteristic.Model, this.airthingsDevice.model)
      .setCharacteristic(api.hap.Characteristic.Name, config.name)
      .setCharacteristic(api.hap.Characteristic.SerialNumber, config.serialNumber)
      .setCharacteristic(api.hap.Characteristic.FirmwareRevision, "Unknown");

    // HomeKit Battery Service
    this.batteryService = new api.hap.Service.Battery("Battery");

    this.batteryService.getCharacteristic(api.hap.Characteristic.BatteryLevel)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.battery ?? 100;
      });

    this.batteryService.getCharacteristic(api.hap.Characteristic.StatusLowBattery)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.battery == null || this.latestSamples.data.battery > 10
          ? api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
          : api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
      });

    // HomeKit Air Quality Service
    this.airQualityService = new api.hap.Service.AirQualitySensor("Air Quality");

    this.airQualityService.getCharacteristic(api.hap.Characteristic.AirQuality)
      .onGet(async () => {
        await this.getLatestSamples();

        let aq = api.hap.Characteristic.AirQuality.UNKNOWN;

        const humidity = this.latestSamples.data.humidity;
        if (humidity != undefined) {
          if (humidity < 25 || humidity >= 70) {
            aq = api.hap.Characteristic.AirQuality.POOR;
          }
          else if (humidity < 30 || humidity >= 60) {
            aq = api.hap.Characteristic.AirQuality.FAIR;
          }
          else {
            aq = api.hap.Characteristic.AirQuality.EXCELLENT;
          }
        }

        const co2 = this.latestSamples.data.co2;
        if (co2 != undefined) {
          if (co2 >= 1000) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.POOR);
          }
          else if (co2 >= 800) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.FAIR);
          }
          else {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.EXCELLENT);
          }
        }

        const mold = this.latestSamples.data.mold;
        if (mold != undefined) {
          if (mold >= 5) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.POOR);
          }
          else if (mold >= 3) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.FAIR);
          }
          else {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.EXCELLENT);
          }
        }

        const pm25 = this.latestSamples.data.pm25;
        if (pm25 != undefined) {
          if (pm25 >= 25) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.POOR);
          }
          else if (pm25 >= 10) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.FAIR);
          }
          else {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.EXCELLENT);
          }
        }

        const radonShortTermAvg = this.latestSamples.data.radonShortTermAvg;
        if (radonShortTermAvg != undefined) {
          if (radonShortTermAvg >= 150) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.POOR);
          }
          else if (radonShortTermAvg >= 100) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.FAIR);
          }
          else {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.EXCELLENT);
          }
        }

        const voc = this.latestSamples.data.voc;
        if (voc != undefined) {
          if (voc >= 2000) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.POOR);
          }
          else if (voc >= 250) {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.FAIR);
          }
          else {
            aq = Math.max(aq, api.hap.Characteristic.AirQuality.EXCELLENT);
          }
        }

        return aq;
      });
    
    if (this.airthingsDevice.sensors.mold) {
      const moldCharacteristic = new api.hap.Characteristic("Mold", "68F9B9E6-88C7-4FB3-B8CE-60205F9F280E", {
        format: api.hap.Formats.UINT16,
        perms: [api.hap.Perms.NOTIFY, api.hap.Perms.PAIRED_READ],
        unit: "",
        minValue: 0,
        maxValue: 10,
        minStep: 1,
      }).onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.mold ?? 0;
      });
  
      this.airQualityService.addCharacteristic(moldCharacteristic);
    }

    if (this.airthingsDevice.sensors.pm25) {
      this.airQualityService.getCharacteristic(api.hap.Characteristic.PM2_5Density)
        .onGet(async () => {
          await this.getLatestSamples();
          return this.latestSamples.data.pm25 ?? 0;
        });
    }

    if (this.airthingsDevice.sensors.radonShortTermAvg) {
      const radonShortTermCharacteristic = new api.hap.Characteristic("Radon (24h avg)", "B42E01AA-ADE7-11E4-89D3-123B93F75CBA", {
        format: api.hap.Formats.UINT16,
        perms: [api.hap.Perms.NOTIFY, api.hap.Perms.PAIRED_READ],
        unit: "Bq/m³",
        minValue: 0,
        maxValue: 16383,
        minStep: 1,
      }).onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.radonShortTermAvg ?? 0;
      });

      this.airQualityService.addCharacteristic(radonShortTermCharacteristic);
    }

    if (this.airthingsDevice.sensors.voc) {
      const VOCDensityCharacteristic = new api.hap.Characteristic("VOC Density", "000000C8-0000-1000-8000-0026BB765291", {
        format: api.hap.Formats.FLOAT,
        perms: [api.hap.Perms.NOTIFY, api.hap.Perms.PAIRED_READ],
        unit: "µg/m³",
        minValue: 0,
        maxValue: 65535,
        minStep: 1,
      }).onGet(async () => {
        await this.getLatestSamples();
        const temp = this.latestSamples.data.temp ?? 25;
        const pressure = this.latestSamples.data.pressure ?? 1013;
        return this.latestSamples.data.voc != null ? this.latestSamples.data.voc * (78 / (22.41 * ((temp + 273) / 273) * (1013 / pressure))) : 0;
      });

      this.airQualityService.addCharacteristic(VOCDensityCharacteristic);
    }

    this.airQualityService.getCharacteristic(api.hap.Characteristic.StatusActive)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.time != null && Date.now() / 1000 - this.latestSamples.data.time < 2 * 60 * 60;
      });

    // HomeKit Temperature Service
    this.temperatureService = new api.hap.Service.TemperatureSensor("Temp");

    this.temperatureService.getCharacteristic(api.hap.Characteristic.CurrentTemperature)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.temp ?? null;
      });

    this.temperatureService.getCharacteristic(api.hap.Characteristic.StatusActive)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.temp != null && this.latestSamples.data.time != null && Date.now() / 1000 - this.latestSamples.data.time < 2 * 60 * 60;
      });

    // HomeKit Humidity Service
    this.humidityService = new api.hap.Service.HumiditySensor("Humidity");

    this.humidityService.getCharacteristic(api.hap.Characteristic.CurrentRelativeHumidity)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.humidity ?? 0;
      });

    this.humidityService.getCharacteristic(api.hap.Characteristic.StatusActive)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.humidity != null && this.latestSamples.data.time != null && Date.now() / 1000 - this.latestSamples.data.time < 2 * 60 * 60;
      });

    // HomeKit CO2 Service
    this.carbonDioxideService = new api.hap.Service.CarbonDioxideSensor("CO2");

    this.carbonDioxideService.getCharacteristic(api.hap.Characteristic.CarbonDioxideDetected)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.co2 == null || this.latestSamples.data.co2 < 1000
          ? api.hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
          : api.hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL;
      });

    this.carbonDioxideService.getCharacteristic(api.hap.Characteristic.CarbonDioxideLevel)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.co2 ?? 0;
      });

    this.carbonDioxideService.getCharacteristic(api.hap.Characteristic.StatusActive)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.co2 != null && this.latestSamples.data.time != null && Date.now() / 1000 - this.latestSamples.data.time < 2 * 60 * 60;
      });

    // Eve Air Pressure Service
    this.airPressureService = new api.hap.Service("Air Pressure", "e863f00a-079e-48ff-8f27-9c2605a29f52");

    this.airPressureService.addCharacteristic(new api.hap.Characteristic("Air Pressure", "e863f10f-079e-48ff-8f27-9c2605a29f52", {
      format: api.hap.Formats.UINT16,
      perms: [api.hap.Perms.NOTIFY, api.hap.Perms.PAIRED_READ],
      unit: "mBar",
      minValue: 850,
      maxValue: 1100,
      minStep: 1,
    }).onGet(async () => {
      await this.getLatestSamples();
      return this.latestSamples.data.pressure ?? 1012;
    }));

    this.airPressureService.getCharacteristic(api.hap.Characteristic.StatusActive)
      .onGet(async () => {
        await this.getLatestSamples();
        return this.latestSamples.data.pressure != null && this.latestSamples.data.time != null && Date.now() / 1000 - this.latestSamples.data.time < 2 * 60 * 60;
      });
  }

  getServices(): Service[] {
    const services = [this.informationService, this.batteryService, this.airQualityService];

    if (this.airthingsDevice.sensors.temp) {
      services.push(this.temperatureService);
    }

    if (this.airthingsDevice.sensors.humidity) {
      services.push(this.humidityService);
    }

    if (this.airthingsDevice.sensors.co2) {
      services.push(this.carbonDioxideService);
    }

    if (this.airthingsDevice.sensors.pressure) {
      services.push(this.airPressureService);
    }

    return services;
  }

  async getLatestSamples() {
    await this.mutex.runExclusive(async () => {
      if (this.airthingsConfig.serialNumber == null) {
        return;
      }

      if (Date.now() - this.latestSamplesTimestamp > 300 * 1000) {
        this.log.info("Refreshing latest samples...");

        try {
          this.latestSamples = await this.airthingsApi.getLatestSamples(this.airthingsConfig.serialNumber);
          this.latestSamplesTimestamp = Date.now();
          this.log.info(JSON.stringify(this.latestSamples.data));
        }
        catch (err) {
          if (err instanceof Error) {
            this.log.error(err.message);
          }
        }
      }
    });
  }
}

interface AirthingsPluginConfig extends AccessoryConfig {
  clientId?: string;
  clientSecret?: string;
  serialNumber?: string;
}
