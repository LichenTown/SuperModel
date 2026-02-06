# SuperModel

A Resource Pack Wrapper for **Minecraft: Java Edition** using Deno.

## What is this for?
**SuperModel** is designed for a very specific purpose: to automatically handle the organization and functionality of a resource pack and create an expandable typescript API to edit your resource pack on the fly.

## What is currently built-in?
| Feature                    | Status  |
|----------------------------|---|
| Item Models (Vanilla/JSON) | ☑️ |
| Entity Models (CEM/JEM)    | ☑️ |
| Entity Textures (CET)      | ❌ |

`☑️` - **`Implemented`** │
`🔃` - **`Planned`** │
`❌` - **`Not Supported`**

## How do I get started?
1) Clone the project: `git clone https://github.com/palmmc/SuperModel.git`.
2) Install [Deno](https://deno.com/).
3) Create or copy resource pack contents (at least a `pack.mcmeta` file) into the `./pack` directory.
4) Configure your pack name, version, and deploy path in `./config.json`
5) Run the watch command `deno run --allow-read --allow-write --allow-net main.ts watch`.
6) That's all!

## How do I learn the format?
Documentation and examples are available on the [**Wiki**](https://github.com/palmmc/SuperModel/wiki).
