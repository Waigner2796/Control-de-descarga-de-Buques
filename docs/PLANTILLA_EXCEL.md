# Plantilla Excel de la empresa

El requerimiento indica que se adjuntaría el Excel que la empresa usa hoy como reporte y que la exportación debe reproducirlo fielmente. **Ese archivo no se recibió**, por lo que no fue posible analizar sus hojas, fórmulas, formatos, colores, logotipos ni diseño de impresión.

## Qué existe hoy

`src/lib/excel/exports.ts` genera libros con ExcelJS que respetan los filtros seleccionados:

- Reporte por servicio: Resumen del servicio, Detalle de pesajes, Resumen por bodega, Productividad por báscula, Análisis de ciclos, Resumen por hora, Tiempos perdidos.
- Detalle de camiones, Ciclos, Tiempos perdidos (+ Pareto), Resumen de tonelaje, Productividad por báscula/bodega/producto, Reporte consolidado del cliente.

La estructura parte de la que ya usaba el prototipo (`legacy/prototipo-control-descarga.html`), con totales como fórmulas `SUM/AVERAGE`, formatos numéricos, fechas en hora local de la terminal, encabezados fijos, autofiltro y configuración de impresión. Todo el formato está centralizado en `src/lib/excel/layout.ts`.

## Para reproducir la plantilla

1. Comparta el archivo `.xlsx` original.
2. Se documentarán sus hojas, columnas, fórmulas, formatos y diseño de impresión.
3. Se ajustarán `layout.ts` y las definiciones de columnas de `exports.ts`; si la plantilla contiene campos que no existen en el modelo, se propondrá su incorporación antes de agregarlos.
