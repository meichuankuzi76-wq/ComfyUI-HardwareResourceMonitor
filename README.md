# ComfyUI-HardwareResourceMonitor

**硬件资源监控 · v1.0**

独立开发的 ComfyUI 资源监控插件，使用中文界面，在主工具栏实时显示 CPU、内存、GPU、显存、温度和功率。监控栏固定宽度、透明背景，内容可横向滑动；设置入口位于监控栏旁边。


![界面预览](screenshot.png)

## 功能介绍

- CPU 使用率、内存使用率及已用 / 总容量。
- GPU 使用率、完整型号、显存使用率及已用 / 总容量。
- GPU 核心温度、显存温度、GPU 功率；硬件未提供的指标显示“未支持”。
- 每项指标配合彩色图标与竖向读数条，型号变长时 GPU 栏及竖条自动后移。
- 460px 固定宽度，支持滚轮、触控板、左右按钮及键盘左右键查看。
- “监控设置”包含全部实时读数总览，即使某项在顶部关闭，也可以在总览查看。
- 独立开关可控制各项显示；显卡型号与 GPU 开关联动。
- 可选择要监控的显卡，以及 0.5 / 1 / 2 秒刷新间隔。
- 配置保存于浏览器，本机设置面板可复制诊断信息。

## 安装

1. 将本仓库克隆或解压为 `ComfyUI/custom_nodes/ComfyUI-HardwareResourceMonitor`。
2. 使用运行 ComfyUI 的同一个 Python 环境安装依赖：

```bash
python -m pip install -r requirements.txt
```

Windows 整合包请使用其内置 Python；例如在插件目录执行：

```powershell
& "F:\ComfyUI-aki-v3.2\python\python.exe" -m pip install -r requirements.txt
```

3. 重启 ComfyUI，浏览器按 Ctrl+F5 刷新。
4. 点击监控栏右侧“设置”，调整刷新间隔与显示项目。

## 支持范围与注意事项

| 平台 | 采集方式 | 当前范围 |
| --- | --- | --- |
| Windows / NVIDIA | NVML + LibreHardwareMonitor | 使用率、显存、温度、功率，按实际硬件能力提供 |
| Windows / AMD、Intel | LibreHardwareMonitor | 库支持这些品牌，具体传感器由型号与驱动决定 |
| Linux / NVIDIA | NVML | 使用率、显存、核心温度、功率 |
| Linux / AMD、Intel 等 | DRM / sysfs / hwmon | 仅采集驱动公开指标，Intel 的完整指标覆盖尚未实现 |

- 已在 Windows RTX 3080 实机验证。AMD、Intel 及 Linux 尚未进行实机验证，不能保证所有显卡的全部指标可用。
- 部分传感器需要管理员权限。读数“未支持”也可能是驱动或硬件未开放该项，并不等于显卡故障。
- 集成显卡共享内存不会被伪装成独立显存容量。
- 容量标签使用 GB，但按 1024³ 字节换算，以保持既有读数习惯；严格计量术语对应 GiB。
- 功率竖条按驱动给出的功率上限计算；未提供上限时仍显示瓦数，不估算比例。
- 温度竖条按温度数值相对 100°C 显示，仅用于视觉参考，不代表安全温度上限。
- 后端采样最小间隔为 0.5 秒；Windows 传感器库约每秒刷新一次，因此 0.5 秒前端刷新不保证产生新的硬件读数。
- 浏览器页面隐藏时暂停请求。Windows 会运行一个隐藏 PowerShell 采集进程，正常退出时关闭。
- 插件仅只读采集，不修改频率、电压、功率限制或风扇。

## 与其他资源监控插件的冲突说明

**建议只启用一个资源监控插件。** 与 ComfyUI-Crystools、ComfyUI-Advanced-Monitor、其他硬件监控插件同时启用时，可能出现：

- 两套监控栏重复显示，挤占主工具栏空间。
- 工具栏插入位置或第三方主题样式互相影响，导致遮挡、换行或显示异常。
- 多个采集进程重复读取硬件，增加 CPU 开销；部分驱动或传感器接口可能相互影响。

这类冲突取决于版本、主题及驱动，并非必然发生。先停用其他监控插件，再重启 ComfyUI 并 Ctrl+F5 刷新。ComfyUI 支持对插件目录添加 `.disabled` 后缀来停用。不要同时保留两个启用的本插件副本。

## 故障反馈

点击“设置 → 复制诊断信息”，提交操作系统、显卡型号、驱动版本及诊断 JSON；同时说明 ComfyUI 版本、是否使用自定义主题、是否启用其他资源监控插件。

若所有 GPU 指标缺失，先检查显卡驱动与 Python 依赖。若仅显存温度缺失，检查权限和硬件支持；采集来源 / 传感器提示可在设置中查看。

## 隐私

插件不包含遥测、上传、广告、自动更新或外部网络请求。前端只请求当前 ComfyUI 服务的 `/hardware-resource-monitor/stats`，设置保存在浏览器 localStorage。

## 引用仓库与第三方依赖

| 项目 / 仓库 | 使用方式与用途 |
| --- | --- |
| [LibreHardwareMonitor/LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) | 使用官方 v0.9.6 发布包中的 Windows 传感器库，读取 NVIDIA、AMD、Intel 显卡信息；没有修改其源代码 |
| [giampaolo/psutil](https://github.com/giampaolo/psutil) | Python 依赖，用于 CPU 使用率和系统内存读数 |
| [aio-libs/aiohttp](https://github.com/aio-libs/aiohttp) | 复用 ComfyUI 自带依赖，提供本地 JSON 监控接口 |
| [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 集成其扩展注册、前端 API 和服务器路由接口；不是复制 ComfyUI 源码 |

另使用 NVIDIA 官方 [nvidia-ml-py](https://pypi.org/project/nvidia-ml-py/) Python NVML 绑定。其已安装包元数据没有声明对应 GitHub 源码仓库，因此不将同名或第三方 pynvml 仓库误标为来源。NVML 运行库由 NVIDIA 驱动提供。

随 LibreHardwareMonitor 官方发行包附带的其他 DLL 及许可证，以 `lib/windows/THIRD-PARTY-NOTICES.txt` 和上游 v0.9.6 发行源码为准。插件原创前后端代码与这些依赖分别遵循各自许可。

## 开源许可与第三方库

本插件原创代码使用 MIT 许可，见 LICENSE。

`lib/windows` 的第三方二进制不适用本插件 MIT 许可：LibreHardwareMonitor 使用 MPL-2.0，其他组件各自遵循原许可。随包附带对应 LICENSE 和 THIRD-PARTY-NOTICES.txt。

- 库来源：https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/tag/v0.9.6
- 对应源码：https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/tree/v0.9.6

## v1.0

首个正式命名版本，包含透明滑动监控栏、中文监控设置、全部读数总览、多显卡选择、跨品牌 Windows 采集和 Linux 基础采集。
